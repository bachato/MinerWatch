# Guardian v2 — Co-tuner V/F continuo vincolato dalla temperatura — Documento di design

> Stato: **implementato (Fase 1 + Fase 2)**; Fase 3 (efficienza) ancora da fare.
> Questo documento descrive l'evoluzione
> del Guardian da *governor di frequenza protettivo* (v1, vedi
> `docs/guardian-design.md`) a *co-ottimizzatore voltaggio+frequenza continuo*,
> che massimizza l'hashrate (o l'efficienza) rispettando un **limite di
> temperatura** impostato dall'utente e una rete di **cutoff di sicurezza**.
>
> Scopo del documento: fissare *cosa fa* e *perché abbiamo scelto di farlo così*,
> in modo che future modifiche partano da un contesto chiaro e non rilitighino
> decisioni già prese. Famiglie target: **Bitaxe** (tutte le rev) e **Nerd\***
> (NerdQAxe / NerdOctaxe), le uniche che espongono `vrTemp`, `set_frequency` e
> `set_voltage` su AxeOS.

---

## 1. Perché esiste questo redesign

Il Guardian v1 è un buon **protettore** ma un **ottimizzatore scarso**, e sul
campo questo si è visto in due modi:

1. **Corsa a vuoto della frequenza.** v1 alza la frequenza quando c'è margine
   termico, ma è cieco al fatto che il chip stia davvero rendendo: su un Gamma
   reale la frequenza saliva mentre l'hashrate *effettivo* crollava (errori
   hardware dell'ASIC che non diventano reject di pool). La 1.10.5 ha messo una
   pezza (freno anti-regressione su un "picco" osservato), ma è un cerotto, non
   la cura.

2. **Una sola leva (frequenza) ha poco margine utile.** Il punto operativo
   sano di un ASIC è una **curva V/F**: ogni frequenza richiede un voltaggio
   minimo per restare stabile. Muovendosi solo in verticale (voltaggio fisso,
   varia solo la frequenza) si esce subito dalla frontiera efficiente — sotto la
   frequenza massima stabile per quel voltaggio si è *sovra-voltati*, sopra si è
   instabili. Come ottimizzatore, la sola frequenza copre una fascia stretta.

### Chiarimento che NON va rilitigato

Abbassare la frequenza tenendo il voltaggio **non danneggia** l'hardware: la
potenza va circa come `V² · f`, quindi a frequenza più bassa con lo stesso
voltaggio il chip assorbe **meno** corrente, scalda **meno** ed è **più**
stabile (ha più margine di voltaggio del necessario). Elettromigrazione e stress
— che dipendono da corrente e temperatura — calano. Il costo della sola
frequenza è di **efficienza** (J/TH peggiora: paghi tutto il voltaggio per meno
lavoro), non di sicurezza. La conseguenza pratica è però chiara: per gestire la
temperatura *bene*, la mossa giusta è scendere lungo la curva abbassando **V e
F insieme**, e questo richiede la leva del voltaggio. Da qui il redesign.

---

## 2. Obiettivo

Tenere ogni miner abilitato **al miglior punto operativo possibile per le
condizioni del momento**, in modo continuo e automatico, dato un **limite di
temperatura** scelto dall'utente:

> Massimizza l'hashrate (modalità *hashrate*) — oppure minimizza i J/TH
> (modalità *efficiency*) — **soggetto a**: temperatura ≤ limite utente,
> hashrate effettivo ≥ soglia di validità (stabilità), e tutti i cutoff hardware
> duri. Riadattati quando l'ambiente deriva.

Perché *continuo* e non un benchmark one-shot: l'ottimo si muove con l'ambiente.
Un benchmark trova un punto statico che invecchia (tra notte e pomeriggio
l'ambiente oscilla anche di 15 °C). Il co-tuner insegue l'ottimo nel tempo.

---

## 3. Da dove viene il metodo (e cosa cambiamo)

Il metodo è ispirato al progetto open-source **`Bitaxe-Hashrate-Benchmark`**
(mrv777, fork di WhiteyCookie, **GPLv3**), da cui discende anche AxeBench (la
cartella dati `~/.bitaxe-benchmark` lo tradisce; AxeBench è la sua evoluzione
chiusa sotto BSL 1.1, di cui non usiamo né leggiamo il codice). GPLv3 è
compatibile con la nostra AGPL-3.0, ma per pulizia **implementiamo in modo
indipendente partendo dall'approccio documentato** — non copiamo codice.

Cosa **prendiamo** dal benchmarker (le idee che lo fanno funzionare):

- **Test di stabilità basato sulla fisica.** Valida un punto operativo
  confrontando l'hashrate misurato con l'hashrate *teorico*
  `freq × smallCoreCount × asicCount / 1000` (GH/s). Considera buono un punto se
  l'hashrate medio è ≥ ~94 % del teorico. È un criterio **assoluto e immediato**
  (sa quanto *dovrebbe* rendere una frequenza), non un "picco" imparato.
- **Salita co-regolata V/F.** Se è stabile → spingi (alza frequenza). Se è
  instabile (hashrate sotto il teorico) → è sotto-voltaggio: **alza il
  voltaggio** per curarla; ritira la frequenza solo se il voltaggio è già al
  massimo.
- **Cutoff duri** controllati a ogni campione (temp chip, temp VR, potenza,
  tensione d'ingresso, min/max di V e F).
- **Disciplina di misura**: assesta dopo un cambio, media su una finestra,
  scarta gli outlier.

Cosa **cambiamo** rispetto al benchmarker (perché il nostro contesto è diverso):

| Benchmarker (one-shot, presidiato) | Guardian co-tuner (continuo, 24/7) |
|---|---|
| **Riavvia** il miner a ogni cambio | Applica **a caldo**, niente reboot (AxeOS applica V e F live) |
| ~12+ min per combinazione, sweep di ore | Loop **lento** (~5 min/tick), un nudge per volta |
| Cerca un ottimo **statico** e si ferma | Insegue l'ottimo **in continuo**, con isteresi |
| Temperatura = **cutoff** | Temperatura = **vincolo/limite** da mantenere |
| Persona davanti che guarda | **Non presidiato** → guardrail più severi, salita di voltaggio prudente e opt-in |

---

## 4. Come si incastra con i loop già esistenti

MinerWatch ha già due anelli che toccano il **chip**:

| Layer | File | Sensore | Leva | Cadenza | Ruolo |
|---|---|---|---|---|---|
| Auto-fan PID | `auto_control.py` | chip (`temp_chip_c`) | ventola | ~5 s | tiene il chip al target (~60 °C) |
| **Guardian co-tuner** | `guardian.py` | **VR** (default) + hashrate | **voltaggio + frequenza** | ~5 min | massimizza V/F sotto il limite di temperatura |
| Watchdog overheat | `auto_control.py` | chip | ventola → 100 % | 5 s | rete dura a 75 °C |

Scelta del sensore del limite: **il VR è il segnale primario** del Guardian,
perché nessun altro anello lo governa. Se l'utente sceglie il **chip** come
limite, il co-tuner diventa di fatto un *terzo* controllore sullo stesso sensore
che il PID ventola già tiene a ~60 °C: il limite-chip morde solo quando la
ventola è satura e non riesce più a tenerlo. È un comportamento legittimo ma va
documentato in UI (lo è già dalla 1.10.3). Il **watchdog 75 °C resta sotto a
tutto** come rete dura: il co-tuner interviene prima e più gentilmente.

---

## 5. I segnali in ingresso

A ogni tick il co-tuner legge dal sample del poller (`MinerSample`):

- **Frequenza e voltaggio correnti** (`frequency_mhz`, `voltage_mv`).
- **Hashrate effettivo** (`hashrate_ths`) — l'EWMA reale di AxeOS.
- **Hashrate teorico** = `frequency × smallCoreCount × asicCount / 1000`.
  `smallCoreCount` è già nel `raw` del Bitaxe (`/api/system/info`); va
  promosso a campo dedicato di `MinerSample` (oggi non c'è).
  → **Validità/stabilità** = `hashrate_effettivo ≥ valid_pct × teorico`
  (default `valid_pct = 0.94`).
- **Temperatura** governata (VR o chip secondo la scelta per-miner).
- **Potenza** (`power_w`) e **tensione d'ingresso** (`voltage` AxeOS, mV).
- **Errori hardware ASIC** (`hw_errors`) — solo telemetria/corroborazione, non
  segnale di controllo (il segnale è l'hashrate, vedi §1).

---

## 6. La legge di controllo

Un **ottimizzatore vincolato** valutato una volta per tick, per ogni miner
abilitato + online + famiglia supportata. Il punto operativo vive dentro un
**inviluppo**: `V ∈ [V_floor, V_ceiling]`, `F ∈ [F_floor, F_ceiling]`, con i
cutoff duri sempre sopra a tutto.

Ordine delle clausole = priorità (la prima che scatta vince e ritorna):

```
0. ASSESTAMENTO
   se (now - last_change) < settle_seconds → pubblica e NON decidere
   (l'EWMA dell'hashrate è in ritardo: agire ora = leggere un transitorio)

1. SICUREZZA (rete dura, batte tutto)
   se chip ≥ chip_cutoff  OR  VR ≥ vr_cutoff  OR  potenza ≥ power_cutoff
      OR  Vin fuori banda [vin_min, vin_max]:
        → back-off d'emergenza: F − step_down_big  e  V − step_down_v
          (o revert all'ultimo punto buono memorizzato); ritorna

2. VINCOLO TEMPERATURA
   se temp_governata > limite_utente:
        → scendi lungo la curva: F − step_down  e  V − step_v
          (abbassare insieme V e F raffredda meglio per hashrate perso)
        ritorna

3. STABILITÀ / VALIDITÀ  (cura l'instabilità col voltaggio)
   se NON valido (hashrate < valid_pct × teorico):
        se V < V_ceiling e c'è margine (temp e potenza sotto soglia):
             → V + step_v        (alza voltaggio per stabilizzare)
        altrimenti:
             → F − step_down     (ritira la frequenza: V è al tetto)
        ritorna

4. OTTIMIZZA IN SU  (solo con margine di temperatura ≥ banda morta)
   modalità HASHRATE:
        se F < F_ceiling: → F + step_up  (e V + step_v se servirà a tenerlo valido)
   modalità EFFICIENCY:
        se V > V_floor e ancora valido: → V − step_v  (scendi verso Vmin → J/TH migliore)
   ritorna

5. ALTRIMENTI → hold (banda morta). Parcheggia: nessuna scrittura.
```

Principi che governano i passi:

- **Asimmetria**: si scende in fretta (passi più grandi in sicurezza/temperatura),
  si sale piano (passi piccoli) → il loop si assesta invece di "cacciare".
- **Isteresi / banda morta** sul limite di temperatura (es. agisci sopra
  `limite`, ricomincia a salire solo sotto `limite − Δ`) e sulla validità, per
  evitare oscillazione al bordo. È la stessa filosofia del v1.
- **Co-movimento V/F in discesa**: quando si scende per temperatura, si abbassa
  anche il voltaggio, restando sulla frontiera efficiente (più raffreddamento
  per hashrate perso). Il "voltaggio minimo per quella frequenza" non lo
  conosciamo a priori: lo si **scopre incrementalmente** (abbassa V finché la
  validità regge; se cade, risali di un passo).
- **Ultimo-punto-buono**: ogni volta che si è validi e sotto tutti i limiti, si
  memorizza `(V, F)` come *last-good*; un cutoff d'emergenza fa **revert** lì.
- **Parcheggio all'equilibrio**: dentro le bande morte non si scrive nulla
  (risparmio NVS, vedi §9).

---

## 7. Disciplina di misura a runtime

- **Assestamento (`settle_seconds`, default 180 s)**: dopo un cambio di V o F
  l'hashrate (EWMA di AxeOS) impiega un minuto o due a stabilizzarsi; prima di
  allora non si prendono decisioni basate sull'hashrate, altrimenti si scambia
  il transitorio per un crollo. 180 s è il valore usato dal tuner a caldo
  terminally-challenged; la cadenza del loop (300 s) gli sta comodamente sopra.
- **Finestra mobile + outlier**: l'hashrate di confronto è una media su qualche
  campione recente, con gli estremi scartati — non il singolo tick (che balla).
- **Cadenza lenta** (≥ tempo di assestamento del VR), come il v1: il limite di
  sicurezza è la cadenza, non il downtime (i cambi sono live).

---

## 8. Sicurezza

La parte *in salita* del voltaggio è la cosa più rischiosa da automatizzare
24/7 (più watt, più calore, più vicino ai limiti di VRM e chip). Per questo:

- **Cutoff duri a ogni tick** (valori di partenza presi dal benchmarker, da
  ritarare sul campo): chip e VR con i loro massimi, **potenza** (es. ~40 W sul
  plug DC del Gamma — fondamentale: alzare il voltaggio alza la potenza),
  tensione d'ingresso in banda (es. 4800–5500 mV), e i limiti assoluti
  `V ∈ [1000, ~1300] mV`, `F ∈ [400, ~1200] MHz`.
- **Tetto di voltaggio conservativo di default** (`v2_voltage_ceiling_mv`, già
  presente) e **passo piccolo** (`v2_voltage_step_mv`), così la salita è lenta.
- **Salita di voltaggio dietro opt-in esplicito** (flag per-miner) con dialog di
  conferma "a tuo rischio" (riusiamo il pattern della 1.10.3). Senza opt-in il
  co-tuner può solo *abbassare* il voltaggio (sicuro) e regolare la frequenza.
- **Revert all'ultimo punto buono** su qualunque cutoff, senza reboot di routine
  (eventuale restart solo come recovery estrema, opzionale).
- **Il watchdog 75 °C sul chip resta la rete dura finale**, indipendente dal
  co-tuner.

---

## 9. Modello dati, config e usura NVS

Config globale (`GuardianCfg`), molte cuciture già presenti:

- `v2_voltage_enabled` (gate globale della leva voltaggio), `v2_voltage_step_mv`,
  `v2_voltage_ceiling_mv`, `v2_voltage_floor_mv` — **già esistono**, oggi inerti.
- Nuovi: `valid_pct` (default 0.94), `settle_seconds`, `power_cutoff_w`,
  `vin_min/max`, eventuale `objective` di default (hashrate | efficiency).

Per-miner (riga `miners`, pattern COALESCE come gli altri campi guardian):

- riuso di `guardian_max_temp_c` (il **limite di temperatura** utente, già c'è)
  e `guardian_temp_source` (vr | chip, già c'è);
- nuovi: opt-in salita-voltaggio, eventuale `objective` per-miner, ed
  eventualmente override di tetto/floor di voltaggio.

Prerequisiti driver: `set_voltage()` / `can_set_voltage` **già presenti** sul
Bitaxe (e ereditati da Nerd\*). Va promosso `smallCoreCount` da `raw` a campo di
`MinerSample`.

**Usura NVS**: sia V sia F persistono nella flash dell'ESP32. Con *due* leve la
superficie di scrittura raddoppia: si scrive **solo su cambio reale** e ci si
parcheggia all'equilibrio dentro le bande morte (come il v1 fa già per la sola
frequenza).

---

## 10. Rischi noti / cosa può andare storto

- **Voltaggio 24/7**: il rischio principale; mitigato da cutoff duri, tetto
  conservativo, passi piccoli, opt-in e revert.
- **Hunting**: ottimizzazione continua + ottimo che si muove = rischio
  oscillazione; mitigato da cadenza lenta, isteresi e asimmetria dei passi.
- **Limiti dell'alimentatore**: la salita di voltaggio alza i watt; il cutoff di
  potenza è obbligatorio, non opzionale.
- **Rumore di misura**: hashrate ed errori ballano a runtime; mitigato da
  assestamento + finestra + outlier.
- **Interazione col PID ventola** in modalità chip (§4): il limite-chip morde
  solo a ventola satura; sul VR è pulito.
- **Scoperta della curva V/F a runtime**: avviene per tentativi piccoli; in
  transitori d'ambiente veloci può inseguire con ritardo (accettabile: la
  sicurezza viene prima della reattività).

---

## 11. Non-obiettivi (cosa NON facciamo)

- Non sostituiamo il PID ventola né il watchdog 75 °C: restano sotto.
- Non facciamo uno sweep completo a ogni avvio (è un *governor* continuo, non un
  benchmark); un eventuale "benchmark di seeding all'attivazione" è un'aggiunta
  futura separata.
- Non supportiamo famiglie senza controllo V/F a caldo (solo Bitaxe / Nerd\*).
- Non garantiamo l'ottimo globale istantaneo: garantiamo convergenza lenta e
  sicura verso un buon punto, rispettando i vincoli.

---

## 12. Piano di rollout (a fasi, per ridurre il rischio)

1. **Fase 1 — base sicura (solo frequenza). ✅ FATTA.** Freno "picco" sostituito
   dal **test sul teorico** (con `expectedHashrate` del firmware, fallback alla
   formula) e **limite di temperatura** come vincolo, a voltaggio fisso. La
   salita di frequenza è gated dalla validità. `decide_frequency` + il percorso
   frequency-only in `_govern_one`.
2. **Fase 2 — leva del voltaggio (co-tuner pieno). ✅ FATTA.** `decide_point`
   (pura, testata) co-regola V/F: cutoff duri → co-discesa per temperatura →
   cura l'instabilità col voltaggio (o taglia freq se V al tetto) → spinge freq
   se valido. Dietro doppio gate (master globale `v2_voltage_enabled` +
   opt-in per-miner `guardian_voltage_enabled`) e conferma UI. Cutoff potenza
   dal `maxPower` del firmware. Applicazione con ordine sicuro (V su prima di F;
   F giù prima di V).
3. **Fase 3 — modalità efficienza e rifiniture.** Obiettivo J/TH, eventuale
   benchmark di seeding all'attivazione, coefficiente di variazione come segnale
   secondario, tuning dei default sul campo. (Ancora da fare.)

Ogni fase è additiva e reversibile (modulo isolato + colonne + flag), dietro il
flag globale `guardian.enabled` e l'opt-in per-miner.

---

## 13. Valori definitivi (decisi)

Decisi con Francesco e confrontati con gli script di riferimento (mrv777,
terminally-challenged). Sono i default; restano configurabili.

- **`valid_pct = 0.97`** — un punto è valido se l'hashrate ≥ 97 % del teorico
  (3 % di tolleranza, più stretta del 6 % del benchmarker mrv777: un governor
  *continuo* deve restare più vicino al bordo efficiente). Tarato sul campo.
- **`error_pct_max = 2.0`** — freno sull'errore: se l'`errorPercentage` del
  firmware supera questa soglia il chip è trattato come instabile anche se
  l'hashrate è ancora valido → in modalità voltaggio alza V (cura), in solo-freq
  scende. Coglie il regime "errori che salgono spingendo la freq a V fisso".
- **deadband temperatura = 3 °C** (era 5): si assesta più vicino al limite
  utente restando sopra lo sbalzo di un singolo passo (anti-hunting).
- **Sensore del limite = VR** di default (nessun altro loop lo governa; sul chip
  litigherebbe col PID ventola — vedi §4).
- **Cutoff di potenza per-modello**: **40 W** per i Bitaxe a singolo ASIC
  (Gamma/Ultra/Supra, tetto del plug 5V/8A, come mrv777); molto più alto / di
  fatto disattivato per i Nerd\* multi-ASIC (70–110 W). È un guardrail della
  **Fase 2** (la potenza sale solo con la leva del voltaggio).
- **Obiettivo di default = hashrate** (la modalità efficiency arriva in Fase 3).
- **Cadenza del loop = 300 s** (riuso del v1) con **`settle_seconds = 180 s`**
  prima di fidarsi dell'hashrate dopo un cambio (valore provato dal tuner a
  caldo terminally-challenged; copre il ritardo dell'EWMA di AxeOS).
- **Passo voltaggio = 10 mV** con **tetto conservativo** (`v2_voltage_ceiling_mv`,
  default attuale 1300) — solo Fase 2, dietro opt-in.
- Segnale secondario opzionale (Fase 3): **coefficiente di variazione**
  dell'hashrate (jitter) come in terminally-challenged (soglia ~0.12).

---

## 14. Riferimenti

- Design del Guardian v1 (protettivo, solo frequenza): `docs/guardian-design.md`.
- Codice attuale: `backend/guardian.py` (`decide_frequency`, `_govern_one`),
  `backend/config.py` (`GuardianCfg`, cuciture `v2_voltage_*`),
  `backend/miners/bitaxe.py` (`set_voltage`, `set_frequency`, parser `raw`).
- Metodo d'ispirazione (open source, GPLv3):
  `Bitaxe-Hashrate-Benchmark` (mrv777 / WhiteyCookie).
- Prodotto chiuso derivato (BSL 1.1, non usato): AxeBench-Release.
