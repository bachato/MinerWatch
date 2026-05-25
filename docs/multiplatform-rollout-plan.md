# MinerWatch — Piano di rollout multi-piattaforma

> Documento di lavoro. Raccoglie l'analisi dello stato attuale, i bug concreti
> individuati, la valutazione dei rischi e il piano di implementazione.
> **Decisioni prese:** Windows = WSL2 (solo documentazione), Umbrel = Community
> App Store (non l'App Store ufficiale, prefisso store `imlenti`, app id
> `imlenti-minerwatch`), immagine Docker pubblicata su GHCR con tag `1.6.0`,
> update in container informativo (mostra se c'è una release più nuova + 
> istruzioni `pull`, niente self-update). Priorità assoluta a **non rompere il
> bare-metal Mac/Linux** che oggi funziona perfettamente.

Versione di rilascio: **1.6.0** (file `VERSION`) — prima release "pulita" con
il supporto multi-piattaforma di questo piano.

---

## 1. Sintesi (executive summary)

Il cuore di MinerWatch è portabile: FastAPI + uvicorn + SQLite (aiosqlite) +
httpx + psutil, tutto cross-platform. La discovery usa socket asyncio (niente
dipendenze da `ping`/`arp`) e `backend/system_info.py` degrada con grazia sui
sistemi non-Pi (`is_raspberry=False`, campi a `None`). Quindi il **runtime gira
ovunque ci sia Python 3.10–3.12**.

I problemi non sono nel codice applicativo, ma in **tre strati di contorno**:

1. Gli script di avvio e di servizio, scritti solo per macOS/Linux.
2. Il meccanismo di auto-update, progettato attorno a launchd/systemd.
3. La distribuzione delle immagini Docker, che **oggi non esiste in CI**.

Questi tre punti spiegano tutto ciò che riportano gli utenti.

| Piattaforma | Stato attuale | Azione prevista |
|-------------|---------------|-----------------|
| macOS (bare-metal) | ✅ Solido | Nessuna |
| Linux (bare-metal) | ✅ Solido | Nessuna |
| Windows | ⚠️ Gira solo "a mano" | Documentare percorso WSL2 |
| Docker | ❌ Bug update + nessuna immagine pubblicata | Fix mirati (vedi §4) |
| Umbrel | ⚠️ Base presente, immagine assente | Community App Store |

---

## 2. Stato per piattaforma

### 2.1 macOS — solido (non toccare)

È la piattaforma di riferimento.

- `installer.command` fa il deploy in `~/Library/Application Support/MinerWatch/`
  (scelta corretta: aggira le restrizioni TCC di privacy che bloccano i job
  launchd dal leggere Desktop/Documenti/Download/iCloud).
- Registra un LaunchAgent con `KeepAlive → SuccessfulExit=false`
  (`scripts/com.imlenti.minerwatch.plist.template`).
- L'auto-update funziona perché `os._exit(1)` fa rilanciare il processo da
  launchd, dopodiché `start.sh` ricostruisce la venv.

**Nessun intervento previsto.**

### 2.2 Linux — solido (non toccare)

- `scripts/install-service.sh` installa una systemd **user-unit** con
  `Restart=on-failure` (`scripts/minerwatch.service.template`).
- Nota presente per l'avvio headless su Pi: `sudo loginctl enable-linger $USER`.
- L'auto-heal del frontend in `start.sh` scarica la `dist/` precompilata dalla
  GitHub Release (~1.5 MB, niente Node necessario su Pi OS Lite); fallback a
  `npm install && npm run build` solo se il download fallisce e Node è presente.
- L'update funziona per lo stesso motivo del Mac (systemd rilancia dopo l'exit).

**Nessun intervento previsto.**

### 2.3 Windows — decisione: WSL2 (solo documentazione)

Nel repo **non c'è nulla per Windows nativo**:

- niente `.bat`/`.ps1`; `start.sh` è bash e usa `ifconfig` (assente su Windows);
- `scripts/install-service.sh` gestisce solo `Darwin`/`Linux` (qualsiasi altro
  OS → `die`);
- soprattutto l'**auto-update è rotto su Windows nativo**: non c'è un service
  manager che rilanci il processo dopo `os._exit(1)`, quindi "Install"
  spegnerebbe MinerWatch senza riavviarlo.

Il codice in sé gira (psutil, asyncio, ecc. sono cross-platform), ma manca tutto
l'involucro. L'utente che "ci è riuscito con l'aiuto dell'AI" lo ha fatto quasi
certamente via WSL2 o lanciando uvicorn a mano.

**Decisione:** Windows = **WSL2**, trattato come Linux. Lavoro richiesto: solo
una sezione di documentazione (vedi §6.4). Zero modifiche al codice.

### 2.4 Docker — bug concreti

Due cose distinte.

**A. L'update è strutturalmente incompatibile col modello a immagine
immutabile** (già documentato nel README). `backend/updater.py` scarica un
tarball, sovrascrive i file dentro `ROOT_DIR` (`/app`) e fa `os._exit(1)`
contando su launchd/systemd. In container:

- il file-swap finisce nel layer scrivibile **effimero**;
- al primo restart (`restart: unless-stopped` nel compose di root,
  `restart: on-failure` in quello Umbrel) Docker ricrea il container
  **dall'immagine**, buttando via l'aggiornamento;
- nell'immagine non esistono né `.venv` né `start.sh`, quindi l'assunzione
  "start.sh reinstalla le nuove dipendenze" non vale.

**B. Bug aggiuntivo: il file `VERSION` non viene copiato nell'immagine.**
Nel `Dockerfile` le uniche COPY verso il runtime (righe 97–103) sono `backend/`,
`config.example.yaml` e `frontend-react/dist`. `VERSION` non c'è. Conseguenza:
in Docker `updater.read_version()` cade nel fallback e ritorna `0.0.0`. Quindi:

- footer e `/api/version` mostrano sempre **0.0.0**;
- `/api/update/check` segnala **sempre** "update disponibile" (qualsiasi release
  > 0.0.0);
- se l'utente clicca "Install", parte lo swap (che riporterebbe `VERSION`), poi
  `os._exit(1)` → restart → l'immagine non ha `VERSION` → di nuovo `0.0.0`.
  È esattamente il loop di "noie con la funzione update".

**C. Installazione/run "normale".** La `docker-compose.yml` di root usa
`image: minerwatch:local` con `build:`, quindi funziona solo con
`docker compose up -d --build`. **Non esiste un'immagine pubblicata**: né
`ci.yml` né `release.yml` fanno build/push su un registry. Inoltre su Docker
Desktop (Mac/Windows) `network_mode: host` viene ignorato → la discovery non
trova nulla (documentato, ma sorprende l'utente).

### 2.5 Umbrel — Community App Store

Quello che c'è oggi in `umbrel/` (`umbrel-app.yml` + `docker-compose.yml` con
`app_proxy` + README) è fatto bene, ma è pensato per l'**App Store ufficiale**
(PR su `getumbrel/umbrel-apps`). Noi andiamo invece di **Community App Store**:
percorso più semplice, nessuna approvazione.

Il Community App Store è un **repo GitHub separato** creato da "Use this
template" (https://github.com/getumbrel/umbrel-community-app-store), con questa
struttura:

- alla radice un `umbrel-app-store.yml` con `id` (prefisso dello store, es.
  `imlenti`) e `name` (nome mostrato in umbrelOS);
- una cartella per app il cui **id deve iniziare col prefisso dello store**:
  es. `imlenti-minerwatch/`, contenente `umbrel-app.yml` + `docker-compose.yml`;
- l'utente aggiunge l'URL del repo dalla UI di umbrelOS e installa con un click.

**Cosa manca per renderlo reale:**

1. **L'immagine Docker pubblicata e multi-arch.** Il compose Umbrel punta a
   `ghcr.io/imlenti/minerwatch:0.1.0`, che **non esiste**. Umbrel scarica
   l'immagine, non la builda. È il prerequisito numero uno.
2. **L'`id` dell'app**: oggi è `minerwatch`, va prefissato (es.
   `imlenti-minerwatch`) e allineato al nome della cartella.
3. **Screenshot** (`1.jpg`–`3.jpg`) e `icon.svg` citati nel README ma non
   presenti nella cartella.
4. Gestione del `VERSION`/update come per Docker (su Umbrel gli aggiornamenti si
   fanno bumpando `version` + tag immagine, **non** col bottone in-app).

---

## 3. Problemi trasversali (le due vere leve)

Il collo di bottiglia comune a **Windows, Docker e Umbrel** è sempre lo stesso:

1. **Auto-update legato al service-manager** → non funziona dove non c'è
   launchd/systemd a rilanciare il processo (Docker, Umbrel, Windows nativo).
2. **Assenza di un'immagine Docker pubblicata** → blocca Docker "vero", Umbrel e
   il Community App Store.

Risolvere queste due cose sblocca tutto il resto.

---

## 4. Valutazione dei rischi: si rompe qualcosa su Mac/Linux?

Risposta sintetica: **3 modifiche su 4 non toccano affatto il percorso
bare-metal; la quarta è l'unica delicata ma si può rendere a rischio
praticamente nullo.**

### 4.1 Pubblicare l'immagine su GHCR — ISOLATO al 100%

Nuovo workflow GitHub Actions che builda il `Dockerfile` esistente. Non tocca
`start.sh`, `installer.command`, `install-service.sh`, né una riga di codice
runtime. Mac/Linux bare-metal non sanno nemmeno che esista. Il peggio possibile:
il workflow fallisce in CI (non arriva mai agli utenti).

### 4.2 Copiare `VERSION` nell'immagine — ISOLATO al 100%

Il `Dockerfile` è usato **solo** per costruire l'immagine; il bare-metal non lo
legge mai. Su Mac/Linux `read_version()` continua a leggere il file `VERSION`
reale dal repo, come oggi. Aggiungere `COPY VERSION` cambia solo cosa c'è dentro
il container. Bonus: questa fix da sola elimina già il falso "update
disponibile" perenne in Docker.

### 4.3 Repo Community App Store — ISOLATO al 100%

Repository GitHub separato. Non modifica il runtime di MinerWatch. Al massimo
aggiungiamo screenshot/icona dentro `umbrel/`, che il bare-metal ignora.

### 4.4 Disabilitare l'update in container — l'unica che tocca codice condiviso

È l'unica da maneggiare con cura, ma si può fare in modo che il ramo bare-metal
resti **byte-per-byte identico a oggi**, usando un segnale esplicito di
container con default "fail-safe":

- nel `Dockerfile`: `ENV MINERWATCH_CONTAINER=1` (esiste **solo** nell'immagine);
- nell'endpoint `POST /api/update/install` (`backend/main.py`): un `if` in cima →
  se quella env è presente ritorna `409` con messaggio "aggiorna con
  `docker compose pull`", altrimenti chiama `updater.install_update()` come ora.

Su bare-metal la variabile non è mai impostata → l'`if` è sempre falso → il
flusso di update resta **esattamente** quello che funziona oggi.

Note di prudenza:

- Si può **non toccare affatto `updater.py`**: il guard vive solo in `main.py`,
  riducendo al minimo la superficie.
- Evitare (o usare solo come fallback) l'euristica `/.dockerenv`: la env
  esplicita non ha alcuna possibilità di attivarsi per sbaglio sul bare-metal.
- Frontend: nascondere il bottone "Install" quando `/api/version` segnala
  modalità container, mostrando invece le istruzioni `pull`. Additivo: il
  bare-metal continua a mostrare il bottone.

---

## 5. Pratiche di sicurezza (per ogni modifica)

- Lavorare su un **branch dedicato**, mai direttamente su `main`.
- Sfruttare lo smoke-test già presente in `ci.yml` (importa l'app FastAPI e
  verifica che le route esistano) su matrice Python 3.10/3.11/3.12.
- Aggiungere un **mini-test** per la rilevazione container: con la env **non**
  settata l'update deve restare abilitato (verifica esplicita della
  non-regressione bare-metal).
- Verificare a mano su Mac e Linux che `start.sh` / installer / update si
  comportino come prima **dopo** ogni modifica.
- Le modifiche al `Dockerfile` e ai workflow non richiedono test sul bare-metal
  perché non sono nel suo percorso, ma vanno comunque provate buildando
  l'immagine.

---

## 6. Piano di implementazione (in ordine di priorità)

### 6.1 Pubblicare l'immagine multi-arch su GHCR — PREREQUISITO

- Nuovo workflow `.github/workflows/docker-publish.yml`.
- `docker buildx` con `--platform linux/amd64,linux/arm64`.
- Trigger su tag `v*` (allineato a `release.yml`); push su
  `ghcr.io/imlenti/minerwatch`. Prima immagine: tag `1.6.0` (= `VERSION`).
- Idealmente pin a digest per la submission/compose Umbrel.
- **Rischio bare-metal: nullo.** Sblocca: Docker "vero", Umbrel, Community Store.

### 6.2 Fix Docker: `VERSION` + guard update in container

- `Dockerfile`: aggiungere `COPY --chown=minerwatch:minerwatch VERSION ./VERSION`
  e `ENV MINERWATCH_CONTAINER=1`.
- `backend/main.py`: guard in `POST /api/update/install` (409 + messaggio
  istruttivo se in container).
- `/api/update/check` o `/api/version`: esporre un flag `container` per la UI.
  Il check verso GitHub resta attivo (mostra se c'è una release più nuova, a
  scopo informativo).
- Frontend: in modalità container, la pagina Update resta visibile ma il bottone
  "Install" è sostituito dalle istruzioni `docker compose pull && up -d`.
- **Rischio bare-metal: nullo** se si usa la env esplicita con default fail-safe
  (vedi §4.4). Aggiungere il test di non-regressione.

### 6.3 Repo Community App Store

- "Use this template" da `getumbrel/umbrel-community-app-store`.
- `umbrel-app-store.yml` alla radice: `id: imlenti`, `name` (es. "MinerWatch
  Store" o simile).
- Cartella `imlenti-minerwatch/` con `umbrel-app.yml` (`id: imlenti-minerwatch`)
  + `docker-compose.yml` adattati da quelli già presenti in `umbrel/`.
- Immagine: puntare al tag pubblicato in §6.1 (pin a digest).
- Aggiungere screenshot `1.jpg`–`3.jpg` (1280×800) e `icon.svg`.
- **Rischio bare-metal: nullo** (repo separato).

### 6.4 Documentazione Windows = WSL2

- Sezione nel `README.md`: installare WSL2, poi seguire le istruzioni Linux
  (`./start.sh` o `scripts/install-service.sh`).
- Nota sui limiti di rete di WSL2 per la discovery (eventuale mirrored
  networking / aggiunta miner per IP).
- **Rischio bare-metal: nullo** (solo testo).

### Ordine consigliato

1. §6.1 immagine GHCR (prerequisito di tutto)
2. §6.2 fix Docker (VERSION + guard)
3. §6.3 Community App Store
4. §6.4 doc Windows/WSL2 (in qualsiasi momento, indipendente)

---

## 7. Cosa NON facciamo (per ora)

- App Store **ufficiale** Umbrel (`getumbrel/umbrel-apps`): rimandato, non è una
  priorità adesso.
- Launcher/servizio **Windows nativo** (.ps1 + Task Scheduler/NSSM o eseguibile
  impacchettato): non necessario, copriamo Windows via WSL2.
- Qualsiasi modifica a `start.sh`, `installer.command`, `install-service.sh`,
  template launchd/systemd: il bare-metal Mac/Linux resta intatto.

---

## 8. Decisioni confermate

- **Prefisso store** (Community App Store): `imlenti`.
- **App id**: `imlenti-minerwatch` (cartella e `id` in `umbrel-app.yml`
  allineati).
- **Tag/versione iniziale dell'immagine** da pubblicare su GHCR: `1.6.0`
  (allineata a `VERSION`).
- **Comportamento update in container**: la pagina Update **resta visibile** e
  `/api/update/check` continua a segnalare se esiste una release più nuova, **a
  scopo informativo**. Al posto del bottone "Install" si mostrano le istruzioni
  `docker compose pull && up -d`. Nessuna esecuzione del self-update in
  container (guard 409 lato API).
