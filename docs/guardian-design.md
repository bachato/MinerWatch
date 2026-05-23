# Guardian — governor di frequenza a runtime — Documento di design

> Stato: **implementato (v1, solo frequenza)**. Backend in `backend/guardian.py`
> + config in `backend/config.py` (`GuardianCfg`) + tre colonne per-miner in DB
> (`guardian_enabled`, `guardian_max_freq_mhz`, `guardian_freq_floor_mhz`) +
> endpoint in `backend/main.py`; UI nella tab **Advanced** del miner
> (`frontend-react/.../GuardianPanel.tsx`). Tutto dietro il flag
> `guardian.enabled` (globale) e l'opt-in per-miner. Famiglie target:
> **Bitaxe** (tutte le rev) e **Nerd\*** (NerdQAxe / NerdOctaxe).
>
> Sostituisce il vecchio **Tuner** (profili Performance / Eco), rimosso. Vedi
> CHANGELOG. Il Tuner era un ottimizzatore one-shot del punto operativo; il
> Guardian è il "guardiano" sempre attivo che mancava — quello che il design
> del Tuner stesso aveva parcheggiato come lavoro futuro.

## 1. Obiettivo

Mantenere automaticamente un miner **sicuro ed efficiente al variare delle
condizioni ambientali** (soprattutto d'estate), senza rifare uno sweep e senza
intervento manuale. Dato un **tetto di frequenza** ("max", di default la
frequenza attuale), il Guardian abbassa la frequenza quando il VR scotta o gli
errori salgono, e la **recupera** verso il tetto quando rinfresca.

Perché non basta un profilo statico (es. "Eco d'estate"): l'estate non è una
temperatura sola — tra notte e primo pomeriggio l'ambiente oscilla anche di
15 °C. Un profilo statico deve essere conservativo per l'ora più calda e quindi
**spreca hashrate** per il resto della giornata. Il Guardian, essendo dinamico,
si riprende quel margine.

## 2. I tre layer di controllo (come si incastrano)

Ognuno sul suo tempo e sul suo sensore — non litigano, si rinforzano:

| Layer | File | Sensore | Leva | Cadenza | Ruolo |
|---|---|---|---|---|---|
| Auto-fan PID | `auto_control.py` | chip (`temp_chip_c`) | ventola | 5 s (loop interno veloce) | tiene il chip al target |
| **Guardian** | `guardian.py` | **VR** (`temp_vr_c`) + HW err% | **frequenza** | ~5 min (loop esterno lento) | tiene VR/errori nei limiti |
| Watchdog overheat | `auto_control.py` | chip | ventola → 100% | 5 s | rete dura a 75 °C |

Il VR è terreno scoperto: oggi **nessun** loop in MinerWatch lo governa (il PID
e il watchdog guardano il chip; il VR compariva solo come cutoff hard del
Tuner). Quando il VR scotta il Guardian taglia frequenza → meno watt → si
raffredda sia il VR sia il chip → il PID ventola rallenta.

## 3. La legge di controllo (v1)

Valutata una volta ogni `interval_seconds` per ciascun miner abilitato:

```
VR temp  > vr_high_c          → frequenza − step_down_vr_mhz    (sicurezza)
HW err % > hw_error_pct_max   → frequenza − step_down_err_mhz   (sicurezza)
VR temp  < vr_low_c           → frequenza + step_up_mhz         (recupero)
altrimenti (banda morta)      → hold
```

Valori di default (`GuardianCfg`, tarati sul campo): `vr_high_c=70`,
`vr_low_c=65` (banda morta = isteresi che evita l'oscillazione al bordo),
`hw_error_pct_max=1.1`, `step_down_vr_mhz=20`, `step_down_err_mhz=10`,
`step_up_mhz=10`, `interval_seconds=300`, `frequency_floor_mhz=400`.

Principi:

- **Le azioni in discesa (sicurezza) battono il recupero in salita**. L'ordine
  delle clausole codifica la priorità: prima la temperatura, poi gli errori,
  poi (solo se nient'altro) si risale.
- **Asimmetria dei passi** (−20 veloce / +10 piano): molla in fretta, recupera
  con calma → il loop si assesta invece di "cacciare".
- Ogni risultato è **clampato a `[floor, ceiling]`**. Il *ceiling* è il "max"
  dell'utente: il Guardian non ci va mai sopra (e se trova la frequenza sopra
  il tetto — es. overclock manuale — la riporta giù al tetto). Il *floor* evita
  di throttlare il miner fino a renderlo inutile.
- La funzione di decisione `decide_frequency(...)` è **pura** (nessun I/O), così
  la policy è testabile in isolamento — vedi `tests/test_guardian.py`.

### Il segnale HW error %

Calcolato a runtime come **delta sui contatori** tra un tick e il precedente:
`Δerrori / Δlavoro × 100` (sorgenti: Bitaxe `hashrateMonitor.asics[].errorCount`
+ `.total`; sommati in `MinerSample.hw_errors` / `hw_total`). Guardie: si usa la
% solo se `Δlavoro > 0`, e un calo dei contatori (reboot del miner) azzera la
baseline invece di produrre una % spuria.

Su **Nerd\*** il firmware espone solo `duplicateHWNonces` (senza denominatore di
lavoro valido), quindi in v1 il termine errori è **inattivo** e governa il solo
VR. È una scelta conservativa, non un bug: la soglia 1.1 % è comunque più lasca
dello standard di un tuning one-shot, perché un governor a runtime deve
tollerare più rumore prima di reagire.

## 4. Perché la cadenza è la manopola di sicurezza

Fatto chiave (confermato sul campo, sia Bitaxe sia Nerd\*): **AxeOS applica il
cambio di frequenza — e di voltaggio — a caldo, senza reboot.** Quindi non c'è
costo di downtime per nudge. Il vincolo diventa l'**inerzia termica del VR**:
dopo un cambio il VR continua a derivare per un minuto o due. Ticchettare più in
fretta di così significherebbe decidere su una lettura non ancora stabilizzata →
oscillazione. Per questo il loop gira su un intervallo lungo (≥ tempo di
risposta del VR); un `cooldown_seconds` opzionale può forzare settle extra.

**Usura NVS.** Un PATCH di frequenza persiste nella flash dell'ESP32. Il
Guardian scrive **solo quando il target è diverso** dalla frequenza live: dentro
la banda morta 65–70 °C si parcheggia su una frequenza d'equilibrio e smette di
scrivere. Le scritture avvengono solo quando l'ambiente deriva oltre soglia —
un numero limitato e sotto controllo.

## 5. Stato per-miner e ciclo del controller

`GuardianController` (in `guardian.py`) è speculare ad `AutoFanController`:
`start()` / `stop()` nella lifespan dell'app, un loop `_run()` che ogni
`interval_seconds` chiama `_tick(poller.last_results)`. Per ogni miner abilitato
+ online + famiglia supportata, `_govern_one(...)`:

1. ricava la frequenza corrente dal sample live (fallback: ultima comandata);
2. calcola l'HW% sull'intervallo (avanza la baseline dei contatori);
3. risolve `ceiling` (= `guardian_max_freq_mhz`, fallback alla freq corrente) e
   `floor` (= `guardian_freq_floor_mhz`, fallback al default globale);
4. chiama `decide_frequency(...)`;
5. se `target == corrente` → **non tocca nulla** (niente scrittura NVS);
6. altrimenti applica `set_frequency(target)` (a caldo), aggiorna lo stato e
   logga; pubblica un readout live per l'endpoint di status.

Lo stato per-miner (`_GuardianState`) tiene i contatori precedenti, l'ultima
frequenza comandata, il timestamp dell'ultimo cambio e l'ultima decisione. Lo
stato viene scartato quando un miner esce dalla lista (offline/disabilitato),
così al rientro riparte con una baseline HW% pulita.

## 6. Modello dati e API

Per-miner, sulla riga `miners` (così arrivano gratis in `get_miner`/`list_miners`
via `SELECT *`):

- `guardian_enabled` (0/1) — opt-in per-miner;
- `guardian_max_freq_mhz` — il tetto "max"; di default = frequenza corrente al
  momento dell'abilitazione, **editabile** dall'utente esperto;
- `guardian_freq_floor_mhz` — override opzionale del floor (NULL = default).

Scrittura via `db.set_guardian_config(...)` (pattern COALESCE come
`set_fan_config`: aggiorna solo i campi passati).

Endpoint:

- `GET /api/miners/{id}/guardian/status` → flag globale, supporto
  (famiglia + capability), opt-in, max/floor, frequenza corrente, default
  (soglie/passi/intervallo) e readout live;
- `POST /api/miners/{id}/guardian/config` → `{enabled?, max_freq_mhz?,
  freq_floor_mhz?}`. All'**abilitazione** senza `max`, il backend default il
  tetto alla frequenza corrente (409 se non ancora nota dal primo poll).

UI: tab **Advanced** del miner (`GuardianPanel.tsx`): toggle di abilitazione,
campo **max frequency** (default = corrente, editabile), floor opzionale,
riepilogo della policy, readout live e una nota di rischio. Tutto gated su
`capabilities.set_frequency` e sul supporto famiglia.

## 7. Sicurezza e reversibilità

- Il **watchdog 75 °C** sul chip resta sempre sotto a tutto come rete dura: il
  Guardian interviene prima e più gentilmente sul VR.
- Il Guardian **non tocca mai il voltaggio** in v1 (vedi §8).
- È un **bolt-on additivo**: vive in un modulo nuovo, usa solo metodi driver già
  esistenti (`set_frequency` / `poll`), tre colonne isolate e due endpoint.
  Dietro un feature flag. Si rimuove cancellando il modulo + le route + la tab +
  le colonne, senza toccare il resto.

## 8. Evoluzione v2 — leva sul voltaggio (NON attiva in v1)

Siccome AxeOS applica **anche il voltaggio** a caldo, si apre una seconda leva.
Il termine errori in v1 cura il sintomo abbassando la frequenza, ma gli errori
da instabilità sono in realtà un problema di **sotto-voltaggio**: la cura
"giusta" sarebbe **+voltaggio**. La v2 potrebbe:

1. rispondere a errori HW sostenuti **alzando `coreVoltage`** (di
   `v2_voltage_step_mv`, entro `v2_voltage_ceiling_mv`) invece di tagliare
   frequenza;
2. quando taglia frequenza, **abbassare anche il voltaggio** in coppia, per
   restare vicino a Vmin e preservare l'efficienza (J/TH).

Perché resta fuori dalla v1: alzare il voltaggio in automatico, 24/7, senza
nessuno davanti, è la leva **più rischiosa** (più calore/watt, più vicino ai
limiti dell'hardware). I parametri (`GuardianCfg.v2_voltage_*`, default
`v2_voltage_enabled=False`) e le cuciture nel codice sono già pronti, inerti
finché la v2 non li legge. Si abilita la v2 solo dopo che la v1 ha dimostrato di
comportarsi bene.

## 9. Limiti noti / non-obiettivi v1

- **Solo frequenza** (niente voltaggio — vedi §8).
- **Solo Bitaxe / Nerd\*** (espongono `vrTemp` e `set_frequency`).
- **Su Nerd\* il termine errori è inattivo** (manca il denominatore): governa il
  solo VR. Fallback a errori/min: possibile evoluzione, non in v1.
- **Nessuna finestra oraria** (l'amico n8n la usava per energia off-peak / fresco
  notturno; MinerWatch gira 24/7, quindi sempre attivo quando abilitato). Una
  finestra oraria è una possibile aggiunta futura.
- È un **throttle protettivo + recupero**, non un ottimizzatore di efficienza:
  scendere di frequenza tenendo il voltaggio fisso peggiora i J/TH in quel
  momento. Accettabile — la sicurezza viene prima (la v2 indirizza l'efficienza).
