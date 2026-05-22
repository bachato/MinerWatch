# Tuner di efficienza/performance — Documento di design

> Stato: **implementato** (v1). Backend in `backend/tuner.py` + endpoint in
> `backend/main.py` + config in `backend/config.py` (`TunerCfg`) + tabelle DB
> `tuner_sessions`/`tuner_points`; UI in `frontend-react/.../TuningPanel.tsx`
> (tab "Tuning" + modale di consenso). Tutto dietro il flag `tuner.enabled`.
> Famiglie target: **Bitaxe** (tutte le rev) e **Nerd\*** (NerdQAxe / NerdOctaxe).
>
> Valori bloccati con l'utente: Performance **62 °C** / ventola 100 %,
> Eco/Cool **58 °C** / ventola 90 %, cutoff hard chip **67 °C**, VR **85 °C**,
> modalità **Accurata** (finestre da 10 min).

## 1. Obiettivo

Invertire la logica dei tool di benchmark esistenti. Oggi gli strumenti
(mrv777 & co.) massimizzano l'hashrate restando *sotto* un cutoff termico
fisso: la temperatura è solo un freno d'emergenza.

Qui invece la **temperatura diventa l'obiettivo di progetto**: dato un
bersaglio termico, trovare la combinazione `frequency` / `coreVoltage` che dà
il **massimo hashrate sostenibile** atterrando attorno a quel bersaglio, con lo
stesso motore su Bitaxe e Nerd\*. Da questo nascono due profili — **Performance**
ed **Eco/Silent** — di cui si discute la sensatezza nella sezione 3.

## 2. Cosa esiste già in MinerWatch (da riusare, non reinventare)

Il design **non parte da zero**: si innesta sull'architettura attuale.

- **Layer driver** — `backend/miners/base.py` definisce `MinerDriver` con i
  flag di capacità (`can_set_frequency`, `can_set_voltage`, `can_set_fan`,
  `can_restart`) e i metodi `poll() -> MinerSample`, `set_frequency(mhz)`,
  `set_voltage(millivolts)`, `set_fan_speed(percent)`, `set_auto_fan(enabled)`,
  `restart()`.
- **Driver concreti** — `bitaxe.py` e `nerdoctaxe.py` implementano tutto.
  `NerdOctaxeDriver` eredita *invariati* gli endpoint di controllo da
  `BitaxeDriver` (stesso payload PATCH). Su `/api/system`:
  `{"frequency": int}`, `{"coreVoltage": int}`, restart su `/api/system/restart`.
  **Nessuna autenticazione** richiesta dal firmware che MinerWatch già supporta.
- **Range validi** — `BitaxeDriver.fetch_asic_info()` legge `/api/system/asic`,
  che espone `deviceModel`, `asicCount` e le liste di opzioni
  frequenza/voltaggio. I limiti si **leggono dal device**, non si hardcodano.
- **Telemetria** — `MinerSample` porta già: `hashrate_ths`, `power_w`,
  `efficiency_w_per_ths` (W/TH), `temp_chip_c` (sensore **più caldo**, già
  collassato con `max()`), `temp_vr_c`, `fan_pct`/`fan_rpm`,
  `current_a` (solo Nerd), `hw_errors` (solo Nerd = `duplicateHWNonces`),
  `accepted`/`rejected`.
- **Auto-fan PID** — `auto_control.py` esegue server-side un PID (costanti
  identiche al firmware Bitaxe) che, in `fan_mode = "minerwatch"`, modula la
  ventola per tenere il chip a `auto_target_c` (default 60 °C). Esiste anche un
  **watchdog overheat** indipendente: sopra 75 °C per 3 campioni forza ventola
  al 100% e manda un alert; rilascia sotto 65 °C.
- **Bus dati** — `poller.last_results` è un `dict[miner_id, MinerSample]`
  aggiornato dal loop di polling; `driver_for_record(record)` costruisce il
  driver giusto per ogni miner.

## 3. Il punto chiave: rapporto col fan PID (risposta alla domanda sui due profili)

Domanda posta: *due profili (uno spinto, uno eco) hanno senso, o quello
performance starebbe comunque sempre dentro al target?*

La risposta dipende da un fatto che il codice rende esplicito: **se la ventola
è in modalità `minerwatch`, il PID tiene il chip a una temperatura target
modulando l'RPM.** Quindi, a *parità di target termico* e con la ventola che
riesce a tenerlo, il chip resta a quella temperatura **per qualsiasi**
combinazione (freq, volt) — finché la ventola non satura.

Conseguenza: a parità di target, ciò che cambia tra "spinto" ed "eco" **non è
la temperatura del chip**, ma:

- l'**hashrate** (più alto se spingi),
- il **consumo** in W,
- il **rumore** (RPM della ventola: per dissipare più calore a parità di temp,
  gira più forte),
- la **temperatura del VR** (`temp_vr_c`), spesso il vero collo di bottiglia,
- l'**efficienza** J/TH,
- il **margine** prima che la ventola saturi.

Quindi l'intuizione "performance resterebbe comunque dentro al target" è
**vera ma incompleta**: sì, il chip resta al target, però paghi in rumore,
consumo e calore dei componenti secondari (VR). Per rendere i due profili
**davvero distinti** — e far sì che "eco = componenti più freschi" sia
*letteralmente* vero — i profili devono differire su almeno uno di questi due
assi:

1. **Target termico diverso**, e/o
2. **Tetto di rumore** (cap sull'RPM/duty massimo della ventola).

Definizione proposta:

- **Performance** — target più alto (es. 65 °C), ventola libera fino al 100%,
  obiettivo = massimo hashrate. In **inverno** l'ambiente freddo lascia molto
  margine alla ventola → si riesce a spingere freq/volt alti tenendo il target.
- **Eco/Silent** — target più basso (es. 55 °C) **+ cap ventola** (es. 90%),
  obiettivo = massima efficienza tenendo i componenti freschi. In estate il cap
  alto privilegia il **raffreddamento** (ventola udibile) sul silenzio assoluto;
  i freq/volt più bassi necessari per il target più basso mantengono comunque
  consumo ed efficienza migliori del profilo Performance.

### Perché lo switch stagionale è sensato (non ridondante)

D'**estate** l'ambiente più caldo fa **saturare la ventola prima**: il profilo
Performance, ai suoi freq/volt alti, non riesce più a tenere il target (il chip
sale, il watchdog a 75 °C rischia di intervenire) e va abbassato. Il profilo Eco,
con target più basso e cap ventola al 90%, mantiene margine e resta fresco.

**Conclusione:** i due profili **non sono ridondanti**, a patto di definirli come
differenze di *target* e/o *cap ventola*, non solo come "quanto spingo verso lo
stesso target". Se condividessero target identico e ventola libera, il tuo
scetticismo sarebbe corretto: il chip starebbe alla stessa temperatura e
l'unica differenza sarebbe hashrate vs rumore/efficienza.

## 4. Architettura del modulo (nuovo `backend/tuner.py`)

Speculare a `auto_control.py`, ma invece di regolare la ventola **cerca la
coppia (freq, volt) ottimale**. Differenza importante di ciclo di vita: l'auto-fan
gira sempre, il **tuner è on-demand** — lo lanci, fa una sessione, applica il
risultato, finisce.

- Un `TunerController` che esegue una **sessione di tuning** su un singolo miner.
- Riusa `driver_for_record(...)`, legge da `poller.last_results` (o fa poll
  diretti durante la sessione per campionamento più fitto), scrive su `db`.
- **Prende il controllo del `fan_mode`** durante la sessione (lo forza a
  `minerwatch` con il target del profilo) e lo **ripristina** alla fine.
- Persistenza dei risultati: tabella dedicata in DB *oppure* JSON in `reports/`
  (decisione aperta, sez. 14).

**Principio di reversibilità (importante).** Il tuner è un *bolt-on* additivo:
vive in un **modulo nuovo**, espone **endpoint nuovi** e una **UI nuova**, e sta
*sopra* il layer driver esistente senza modificarlo. Niente modifiche al cuore
di `base.py`, `bitaxe.py`, `nerdoctaxe.py`, `poller.py` o `auto_control.py`: usa
solo metodi che esistono già (`set_frequency`/`set_voltage`/`restart`/
`set_fan_speed`/`poll`) e che sono già usati da altre feature. I risultati vanno
in una **tabella DB separata** (non colonne sul record miner), così si possono
eliminare senza toccare lo schema condiviso. In sviluppo sta dietro un **feature
flag**. Conseguenza: se non convince, si rimuove cancellando modulo + route +
tab senza rompere il resto (vedi anche la risposta in chat sulla reversibilità).

## 5. Modello dati per ogni punto testato

Ogni combinazione (freq, volt) provata produce un record:

`frequency`, `coreVoltage`, hashrate medio misurato, hashrate teorico atteso,
`temp_chip_c` a regime, `temp_vr_c`, `power_w`, `J/TH` calcolato,
`fan_pct` a regime (= proxy del rumore), delta `hw_errors` (solo Nerd) /
delta `rejected`, esito (`valido` / `instabile` / `scartato-sicurezza`).

## 6. Macchina a stati di un singolo punto

1. **Set** → `set_frequency` + `set_voltage`.
2. **Restart** → `restart()` e attesa riavvio firmware.
3. **Settle** → attesa del **regime termico** (temperatura appiattita, derivata
   ~0), non un tempo fisso. Più lungo su Nerd (8 ASIC, massa termica grande).
4. **Sample** → finestra di campionamento, scartando i primi campioni (warmup)
   e rimuovendo gli outlier dell'hashrate.
5. **Validate** → hashrate entro X% del teorico **e** errori stabili
   (`hw_errors`/`rejected`) **e** ventola non satura.
6. **Safety** → cutoff continui su `temp_vr_c`, `current_a`/`power_w`, e il
   watchdog 75 °C già esistente. Se scatta, abortisci il punto e torna
   all'ultima config buona.
7. **Record** → salva e passa oltre.

## 7. Strategia di ricerca

La griglia completa funziona ma è lentissima (decine di punti × ~10–15 min).
Sfruttiamo due fatti fisici per essere più furbi:

- a frequenza fissa l'hashrate è ~costante *finché il chip è stabile*; sotto un
  certo voltaggio iniziano gli errori e l'hashrate effettivo crolla;
- la **saturazione della ventola** (con il fan PID attivo) è un ottimo segnale
  di "siamo al limite del target".

Fasi:

- **Fase 0 — Discovery & baseline.** Identifica device e range via
  `/api/system/asic`; registra un punto di riferimento alla config attuale.
- **Fase 1 — Frontiera di efficienza.** Per ogni frequenza candidata, trova il
  **voltaggio minimo stabile** (il più basso che tiene hashrate ≈ teorico e
  errori bassi). È il punto più freddo/efficiente per quella frequenza.
- **Fase 2 — Salita verso il target.** Sali di frequenza (ognuna al suo Vmin
  stabile) finché il fan PID non comincia a **saturare** per tenere il target,
  o il VR si avvicina al limite. Usa una **bisezione** invece di scansionare
  tutto: pochi punti per convergere.
- **Fase 3 — Raffinamento & Pareto.** Intorno al punto trovato, prova qualche
  variante e costruisci la **frontiera di Pareto** (hashrate vs `fan_pct`/rumore
  vs J/TH). La scelta finale esce dalla funzione di punteggio del profilo.

## 8. Funzione di punteggio e profili

Forma proposta (penalità termica **asimmetrica**: zero sotto il target, cresce
al quadrato sopra):

```
score = hashrate
        - k * max(0, temp_chip - target)^2     # rispetto del target termico
        - w * fan_pct                            # rumore
        - m * (J/TH)                             # efficienza
```

I pesi definiscono i preset:

| Profilo      | Target chip | Cap ventola | k (termico) | w (rumore) | m (eff.) | Carattere |
|--------------|-------------|-------------|-------------|------------|----------|-----------|
| Performance  | 62 °C       | 100%        | basso       | ~0         | basso    | spreme hashrate (ideale d'inverno) |
| Eco / Cool   | 58 °C       | 90%         | alto        | medio      | alto     | componenti freschi, ventola decisa (ideale d'estate) |

> Si parte con **due** profili (decisione confermata): niente "Bilanciato" in
> v1, eventualmente come terzo preset più avanti.

> I valori numerici sono indicativi: vanno tarati. La scelta del **carattere di
> default** (conservativo vs aggressivo) è una decisione aperta — vedi sez. 14.

## 9. Lancio e consenso al rischio (modale)

Al click su **qualsiasi** profilo (Eco *o* Performance) compare una modale di
consenso obbligatoria. Comportamento:

- Il pulsante di conferma resta **disabilitato** finché non viene spuntato il
  tick obbligatorio.
- La modale compare **a ogni lancio**: nessun "non mostrare più". Il consenso si
  dà ogni volta, e il pulsante di conferma è *sempre* formulato come
  un'assunzione esplicita del rischio.
- Testi **in inglese** (l'app è in inglese), con una strizzata d'occhio ai
  dragoni dell'overclock Bitaxe.
- Il tick è un gate di **consapevolezza**, non disattiva nulla: il watchdog
  75 °C e i cutoff hard restano sempre attivi.

Stringhe letterali (UI copy):

```
Title:    🐉 Here be dragons

Body:     This profile pushes your hardware toward its limits to find the
          fastest frequency/voltage combo it can sustain at your target
          temperature.

          You run it entirely at your own risk. Stay near your miner while
          the tuner is running and keep an eye on it — temperature, noise,
          smell. If anything looks off, cut the power immediately.

          Legend says overclocking a Bitaxe once meant summoning a dragon.
          We've automated the incantation — but the dragon is still real,
          and it does NOT like being left unattended. 🐉

Checkbox (required, unchecked by default):
          I take the risk by running this function

Confirm button (enabled only once the box is checked):
          Summon the dragon — at my own risk

Cancel button:
          Maybe later
```

> La stessa modale vale per entrambi i profili; cambia solo il nome del profilo
> citato nel corpo. La copy è volutamente diretta sui rischi (calore, odore,
> rumore, "stacca la corrente") e ironica solo nella riga di mezzo.

## 10. Sicurezza e ripristino

- I cutoff hard stanno **sempre sopra** il target e fanno da rete.
- Il **watchdog 75 °C** già esistente resta attivo durante il tuning.
- A fine sessione si applica la **config scelta** (non l'ultima testata, che
  potrebbe essere instabile) e la si salva.
- **Ripristino** del `fan_mode` originale del miner alla fine.
- Limitare le scritture inutili in **NVS** (non riscrivere se il valore non
  cambia) per non usurare la flash dell'ESP32.
- **Resume** da checkpoint se la sessione viene interrotta.

## 11. Differenze Bitaxe vs Nerd\* (cosa cambia per il driver)

| Aspetto | Bitaxe | NerdOctaxe / NerdQAxe |
|---|---|---|
| ASIC | 1 (o pochi su SupraHex) | 8 (Octaxe) / 4 (QAxe++) |
| Massa termica / settle | breve | **lungo** (più ASIC) |
| Dominio freq/volt | unico | **unico** anche qui: un solo set per tutti i chip |
| `current_a` | non esposto | esposto (`currentA`) → utile per limite alimentatore |
| Errori HW | non nel driver attuale | `duplicateHWNonces` (aggregato) |
| Ventole | 1 | 2 (`fanrpm2`/`fanspeed2`) |
| Auth controllo | nessuna | **nessuna** sul firmware target (nota: alcune build NerdQAxe di terzi richiedono una *session key* — non quelle qui) |
| Range validi | `/api/system/asic` | `/api/system/asic` |

Il motore di ricerca è **identico**; cambiano solo costanti (tempi di settle) e
la disponibilità di alcuni segnali (su Bitaxe la stabilità si valida con
hashrate-vs-teorico + `rejected`, mancando un contatore HW dedicato).

Nota multi-ASIC: i chip condividono un solo dominio freq/volt, ma scaldano in
modo diverso. È il **chip più caldo** a vincolare — e `temp_chip_c` è già il
`max()` dei sensori, quindi la metrica giusta è già lì.

## 12. Problemi noti e mitigazioni

- **Durata.** Anche con la ricerca furba, ogni punto = restart + settle +
  campionamento. Su Nerd può essere lungo → modalità "veloce" vs "accurata".
- **Definizione di "regime".** Misurare troppo presto falsa tutto. Aspettare
  l'appiattimento della temperatura, non un tempo fisso. Più critico su Nerd.
- **Rumore dell'hashrate.** Il valore è una media mobile, ballerina nel breve →
  finestra lunga + rimozione outlier.
- **Hashrate "locale" ≠ share reali.** Un undervolt aggressivo può dare
  hashrate apparente buono ma molti share scartati. Usare `hw_errors` (Nerd) e/o
  l'andamento di `rejected` come secondo criterio di stabilità.
- **Silicon lottery.** L'ottimo è **per-device**: i risultati non sono un preset
  universale trasferibile a un altro esemplare, neanche stesso modello.
- **VR come vero limite.** Su molti board è `temp_vr_c` a salire prima del chip:
  il target/cutoff deve poter guardare anche il VR.
- **Saturazione ventola = segnale.** Con il fan PID attivo, la ventola al
  massimo che non tiene più il target è il segnale operativo di "limite".
- **Usura NVS / brownout.** Tanti restart scrivono in flash; e spingendo i watt
  un alimentatore debole abbassa la tensione → monitorare `current_a`/input.
- **Interazione con l'auto-fan.** Il tuner deve **prendere il controllo** del
  `fan_mode` per la durata della sessione e ripristinarlo dopo, per non
  combattere col PID già attivo.
- **Concorrenza col poller.** Coordinarsi con `poller`/`auto_control` per non
  avere due attori che scrivono sullo stesso miner contemporaneamente.

## 13. Scope della v1 / non-obiettivi

- È un **finder one-shot**, non un demone sempre attivo.
- **Niente** tuning indipendente per board (dominio unico).
- Possibile, in futuro, una modalità "guardiano" che riverifica ogni tanto —
  ma fuori dalla v1 per non incrociare due logiche.

## 14. Domande aperte / prossimi passi

1. **Carattere di default** dei profili (conservativo Eco vs aggressivo
   Performance) → fissa i valori iniziali di target, cap ventola e pesi `k/w/m`.
   → **Risolto in v1**: Performance 62 °C / 100 %, Eco 58 °C / 90 %, cutoff 67 °C.
2. **Persistenza** dei risultati: tabella DB o file in `reports/`?
   → **Risolto in v1**: tabelle DB separate `tuner_sessions` / `tuner_points`.
3. **UI**: nuova tab "Tuning" per-miner, accanto a "Controls"? I due profili
   (Eco/Performance) vivono lì e il click apre la modale di consenso (sez. 9).
4. **Integrazione**: sessione separata, o un `fan_mode`/modalità aggiuntiva?
5. **Validazione hashrate teorico**: leggerlo dal firmware se disponibile, o
   calcolarlo da `frequency × asic_count × fattore_core`?
   → **v1**: auto-calibrato dal baseline (`ths_per_mhz × freq`). Superato dalla
   **v2** (sez. 15), che sposta il criterio di stabilità sull'HW error rate.
6. **Nome del profilo Eco**: con il cap ventola a 90% il profilo è più "cool"
   che "silent" — tenere "Eco/Silent" o rinominarlo (es. "Eco/Cool")?
   → **Risolto in v1**: rinominato **Eco / Cool**.

## 15. Evoluzione v2 — stabilità basata su HW error rate

> Stato: **implementata** (v2). Origine: confronto con un utente esperto di
> tuning. Non cambia l'architettura; sostituisce *un solo* criterio interno al
> motore. Decisioni finali in 15.8.

### 15.1 Motivazione

La v1 giudica la stabilità di un punto confrontando l'**hashrate misurato**
con quello atteso (`avg_h >= stability_fraction × expected`, dove
`expected = ths_per_mhz × freq` auto-calibrato dal baseline). È un proxy
**tardivo e rumoroso**: l'hashrate riportato dal firmware è una media mobile,
e un chip sotto-voltato può restare al ~98% del teorico mentre genera un numero
crescente di nonce invalidi (errori hardware) che il pool poi rifiuta — lavoro
sprecato che il nostro gate non vede.

Il metodo "canonico" usato da chi fa tuning serio è invece: fissata la
frequenza, **alzare il voltaggio di 10 mV alla volta finché l'HW error rate
scende sotto una soglia desiderata** — quello è il Vmin "buono" per quella
frequenza. L'HW% è un indicatore **diretto e precoce** dell'instabilità da
sotto-volt: cattura il problema prima che l'hashrate medio mostri il calo.

Conclusione: la *sequenza* della v1 è già quella giusta (freq → Vmin → arrampica
→ limitato dalla temperatura); va cambiato solo il **segnale** che decide
"voltaggio buono".

### 15.2 Cosa cambia rispetto alla v1

1. **Esporre l'HW error count nei driver.** Il dato grezzo c'è già:
   - **Bitaxe**: `hashrateMonitor.asics[]`, ogni ASIC con `errorCount` (+ `total`).
     Oggi `bitaxe.py` non lo mappa in `MinerSample` (lo cita solo nel commento di
     `_asics_from_monitor`). Va sommato/surfacing in un nuovo campo.
   - **Nerd\***: `duplicateHWNonces` (conteggio **aggregato**), già esposto come
     `sample.hw_errors` da `nerdoctaxe.py`. Non è una percentuale.
2. **Spostare il gate** in `_measure_point` / `_find_vmin_point`: da
   "hashrate ≥ frazione del teorico" a **"HW% ≤ soglia"**, con l'hashrate tenuto
   come *check secondario di sanità* (un punto con HW% basso ma hashrate crollato
   resta sospetto). Il campo `hw_errors_delta` che già salviamo per punto diventa
   così un **input decisionale**, non solo informativo.
3. **Step di voltaggio a 10 mV** (`voltage_step_mv` da 20 → 10): Vmin più preciso,
   più efficienza, coerente con la modalità Accurata. Costa più punti per
   frequenza (alzare `max_probes` di conseguenza).

### 15.3 Definizione dell'HW% (il punto delicato)

Serve numeratore **e** denominatore su una *finestra*. Precedente in casa:
`BoardSnapshot.hw_error_rate` usa la formula cgminer `HW / (HW + Diff1Work) × 100`.
Per AxeOS le opzioni:

- **Bitaxe**: `errorCount` per-ASIC è un contatore monotòno → usare il **delta**
  sulla finestra di campionamento; come denominatore il delta di un contatore di
  lavoro valido (es. `total` del monitor, o `sharesAccepted`). HW% = ΔerrorCount /
  (ΔerrorCount + Δlavoro) × 100.
- **Nerd\***: solo `duplicateHWNonces` aggregato → delta su finestra; denominatore
  più incerto (manca un per-chip), si può approssimare con Δshare o con il lavoro
  atteso da `hashrate × tempo`.

Decisione aperta: **quale denominatore** rende l'HW% confrontabile tra le due
famiglie. Se non si trova un denominatore affidabile su Nerd\*, ripiego: usare
il **tasso di errori al secondo** (Δerrori / Δt) con soglia per-famiglia, invece
di una vera percentuale.

### 15.4 Soglia configurabile

Come dice l'utente ("your desired level"), la soglia va **configurabile** in
`TunerCfg` (es. `hw_error_pct_max`), perché lo zero assoluto non esiste — ogni
chip ha un rumore di fondo. Valore di partenza da tarare (es. < 0,5–1%).
Eventualmente per-profilo (Eco più severo, Performance più permissivo).

### 15.5 Cosa resta invariato

Tutto il resto dell'impianto: sweep di frequenza, **auto-fan PID** che tiene il
target + cap ventola, **cutoff hard** (chip/VR/potenza/tensione), profili,
selezione del vincitore via punteggio normalizzato (Pareto), persistenza,
modale di consenso, reversibilità. Il temperature-management della v1 si combina
bene col gate-su-errori: lui regola il "quanto voltaggio", noi continuiamo a
gestire "quanto caldo".

### 15.6 Punti di intervento nel codice

- `backend/miners/bitaxe.py` (+ `nerdoctaxe.py`): parsing di `errorCount` →
  nuovo campo in `MinerSample` (es. `hw_error_count` per-ASIC sommato, o un
  `hw_error_rate` già calcolato).
- `backend/miners/base.py`: campo nuovo in `MinerSample`.
- `backend/tuner.py`: `_measure_point` (calcolo HW% sulla finestra + nuova
  classificazione `outcome`), `_find_vmin_point` (gate sul nuovo segnale),
  eventuale `max_probes`.
- `backend/config.py`: `voltage_step_mv` 20→10, nuovo `hw_error_pct_max`
  (eventualmente per-profilo), eventuale deprecazione di `stability_fraction`.
- Frontend: la colonna errori c'è già (`hw_errors_delta`); semmai mostrarla come
  HW% e marcarla come criterio di scelta.

### 15.7 Avvertenze

- La v2 dipende dalla **qualità del dato di errore** del firmware; se un build
  non espone `errorCount`, si ricade sul criterio hashrate (mantenere il gate v1
  come fallback, non rimuoverlo).
- Step a 10 mV + HW% per-finestra = **sessioni più lunghe**: va comunicato nella
  UI/stima tempo.

### 15.8 Decisioni finali (implementate)

- **Metrica primaria**: **HW error % reale** = `errorCount / total` (somme dal
  `hashrateMonitor`) sulla finestra, ×100. Calcolata in
  `tuner.py::_measure_point`; usata solo quando il Δ del denominatore è > 0
  (guardia contro un `total` non monotòno).
- **Soglia**: `TunerCfg.hw_error_pct_max`, **unica per entrambi i profili** (la
  stabilità è uno standard di sicurezza). Default **0,6 %** — il livello che gli
  utenti trovano "soddisfacente". Da confermare/tarare dai risultati.
- **Sorgenti**: Bitaxe = `hashrateMonitor.asics[].errorCount` + `.total`
  (`_hw_errors_from_monitor` / `_hw_total_from_monitor` → `MinerSample.hw_errors`
  / `hw_total`). Nerd\* = `duplicateHWNonces` (senza denominatore valido →
  `hw_total` azzerato per non creare una % con contatori disallineati).
- **Fallback a cascata**: se manca il denominatore (Nerd\* o firmware senza
  `total`) → **errori/min** (`hw_error_rate_max_per_min`, default 5/min); se non
  c'è nessun contatore errori → **hashrate vs atteso** (`stability_fraction`).
- **Step voltaggio**: 10 mV (`voltage_step_mv`), `max_probes` = 25.
- **Check secondario di sanità**: un punto con hashrate < 50% dell'atteso è
  scartato anche con errori bassi (chip bloccato/quasi fermo).
- **UI**: colonna **HW err %** nella tabella dei punti (`TuningPanel.tsx`); la
  tab si chiama **"Tuning (Advanced only)"**.
- **Avvertenza**: il significato esatto di `total` va confermato su un miner
  reale; finché non è verificato, le guardie (Δ>0, fallback) evitano risultati
  sballati.
