# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Base operativa

> Compromesso: queste linee guida favoriscono la cautela rispetto alla velocità. Per compiti
> banali, usa il buon senso.

## 1. Pensa prima di codificare

Non presumere. Non nascondere confusione. Fai emergere i compromessi.

Prima di implementare:

- dichiara esplicitamente le tue ipotesi; se sei incerto, chiedi;
- se esistono più interpretazioni, presentale — non sceglierne una in silenzio;
- se esiste un approccio più semplice, dillo, e insisti quando serve;
- se qualcosa non è chiaro, fermati: nomina ciò che è confuso e chiedi.

## 2. Prima la semplicità

Codice minimo che risolve il problema. Niente di speculativo.

- niente funzionalità oltre a quelle richieste;
- niente astrazioni per codice a uso singolo;
- niente "flessibilità" o "configurabilità" non richiesta;
- niente gestione degli errori per scenari impossibili;
- se scrivi 200 righe e potrebbero essere 50, riscrivi;
- chiediti: «un ingegnere senior direbbe che è troppo complicato?» Se sì, semplifica.

## 3. Modifiche chirurgiche

Tocca solo ciò che devi. Pulisci solo il tuo casino.

Quando modifichi codice esistente:

- non "migliorare" codice, commenti o formattazione adiacenti;
- non rifattorizzare ciò che non è rotto;
- mantieni lo stile esistente, anche se tu lo faresti diversamente;
- se noti codice morto non correlato, segnalalo — non eliminarlo.

Quando le tue modifiche creano orfani:

- rimuovi import/variabili/funzioni che le tue modifiche hanno reso inutilizzati;
- non rimuovere codice morto preesistente se non richiesto.

Il test: ogni riga cambiata deve riferirsi direttamente alla richiesta dell'utente.

## 4. Esecuzione guidata dagli obiettivi

Definisci i criteri di successo. Itera fino a verifica.

Trasforma i compiti in obiettivi verificabili:

- «aggiungi validazione» → «scrivi un test per input non validi, poi fallo passare»;
- «correggi il bug» → «scrivi un test che lo riproduca, poi fallo passare»;
- «rifattorizza X» → «assicurati che i test passino prima e dopo».

Per compiti a più passaggi, dichiara un piano breve:

```
1. [Passo] → verifica: [controllo]
2. [Passo] → verifica: [controllo]
```

Criteri di successo forti permettono di iterare in autonomia; criteri deboli («fai funzionare»)
richiedono chiarimenti continui.

## 5. Ogni errore va riportato in `MISTAKES.md`

`MISTAKES.md` cataloga i difetti che hanno **raggiunto il sito o il dataset pubblicato**, non le
ipotesi misurate e respinte (quelle stanno in `docs/misure-riferimento.md` e sono il
funzionamento normale del progetto).

Ogni difetto trovato o corretto durante una sessione va aggiunto lì, con le quattro voci del
formato già in uso:

1. **Cosa** è successo (il meccanismo, non il sintomo);
2. **Quanto è costato** (misurato, o «nessun impatto misurabile» se è così);
3. **Perché nessun test l'ha visto** — la voce che conta;
4. **Cosa lo intercetta adesso** (il test o il contratto aggiunto).

Aggiorna anche il conteggio e la tabella di §«Il quadro d'insieme» in testa al file.

Queste linee guida funzionano se: i diff contengono meno modifiche non necessarie, ci sono meno
riscritture dovute a complicazioni, e le domande di chiarimento arrivano prima
dell'implementazione invece che dopo gli errori.

---

# Comandi

```bash
npm start                 # server statico di sviluppo (scripts/serve.mjs) su :8000
npm start -- --port 8080  # porta alternativa
npm test                  # tutti i test JS (node --test non è usato: sono script con assert)
node tests/schedina.test.js   # un singolo test: eseguilo direttamente, non serve un runner
npm run check             # node --check su ogni file JS (sintassi)
npm run test:py           # unittest Python (contratti sul dataset vero)
node scripts/python.mjs -m py_compile scripts/*.py   # compilazione Python
```

Misura e diagnostica (nessuna rete richiesta, leggono `data/matches.json`):

```bash
npm run backtest -- --competition ita.1 --since 2025-08-01 --max 500
npm run backtest:market   # confronto con le quote di chiusura de-vigate
npm run diagnose          # scomposizione della calibrazione (bias lambda, curva di affidabilità)
npm run diagnose:confidence
npm run fit:calibration   # ristima DEFAULT_CALIBRATION su training + holdout
npm run tune              # coordinate descent sugli iperparametri (overfitting reale: valida su holdout)
```

Rigenerazione del dataset (rete verso ESPN / UEFA / Football-Data / Understat):

```bash
node scripts/python.mjs -m pip install -r requirements.txt
node scripts/python.mjs scripts/update_top5_data.py --history-seasons 4
node scripts/python.mjs scripts/enrich_competitions_players.py
```

**Non invocare `python`/`python3` direttamente** negli script o nella documentazione: passa da
`node scripts/python.mjs`, che risolve il nome dell'eseguibile su Windows/WSL/Linux/macOS.

# Architettura

Web app **statica**, moduli ES caricati direttamente dal browser: nessun bundler, nessun
`node_modules`, nessuna dipendenza JS. Deploy su GitHub Pages servendo la root del repo.

## Il flusso di una previsione

```
data/matches.json  →  matchdays.js (catalogo + turni)  →  model.js (predictFromMatches)
        ↑                                                        ↑
   pipeline Python                                    prediction-inputs.js (modelInputs)
```

- **`model.js`** (~2500 righe) è il modello, puro e senza DOM: Elo cronologico, medie pesate per
  recenza in giorni, Poisson + Dixon-Coles, calibrazione dei lambda (`DEFAULT_CALIBRATION`),
  iperparametri (`DEFAULT_HYPERPARAMETERS`), mercati derivati (`deriveMarkets`) e mercati sui
  giocatori (`estimatePlayerMarkets`). Tutti i mercati mostrati nascono dalla **stessa matrice
  dei punteggi**, quindi non possono contraddirsi.
- **`prediction-inputs.js`** è l'unica sorgente degli input che decidono *come* si prevede.
  Produzione (`app.js`, `schedina*.js`) e misura (`scripts/*.mjs`) costruiscono le opzioni come
  `{ ...modelInputs(...), <identità della partita> }`. Vedi le regole R13/R14 più sotto.
- **`matchdays.js`** definisce `SUPPORTED_COMPETITIONS` (`ucl`, `uel`, `uecl`, `eng.1`, `esp.1`,
  `ita.1`, `ger.1`, `fra.1`) e raggruppa le fixture in turni; i campionati minori esistono nel
  dataset solo come supporto interno a forma ed Elo e non vanno esposti nel selettore.
- **Pagine**: `index.html`/`app.js` (pronostici e modale partita), `schedina.html` +
  `schedina-page.js` (DOM) + `schedina.js` (candidati e quote) + `slip-builder.js`
  (ottimizzatore puro, zaino su −ln p), `settings.html`, `admin.html`.
- **Preferenze**: `preferences.js` e `competition-preference.js` su `localStorage`;
  `global-settings.js` + `firebase-client.js` leggono impostazioni globali da Firestore
  (opzionale: senza configurazione l'app funziona lo stesso).

## La pipeline dati (Python, `scripts/`)

`update_top5_data.py` è l'entry point e orchestra `update_europe_data.py` (Big Five: ESPN,
Football-Data.co.uk, Understat) e `update_uefa_data.py` (coppe: API UEFA con fallback ESPN).
`enrich_competitions_players.py` aggiunge poi `team_context` e `player_context` (rose, minuti,
formazioni probabili). Output unico: `data/matches.json`.

La normalizzazione dei nomi squadra (`normalize_team`, `TEAM_ALIASES`,
`resolve_spelling_collisions`, `UEFA_TEAM_OVERRIDES`) è il punto più delicato dell'intera
pipeline: fonti diverse scrivono lo stesso club in modo diverso, `merge_matches()` deduplica e
`enrich_xg()` aggancia gli xG sulla stessa chiave. Una grafia divergente non solleva
un'eccezione — produce numeri plausibili e un club spezzato in due identità. È la famiglia di
difetti che è costata di più (`+0.0145` di log loss in Champions una volta corretta).

## Test

Non c'è un framework: ogni test è uno script ES che usa `node:assert/strict` e si esegue da solo
(`node tests/nome.test.js`). I test Python sono `unittest` e girano sul **dataset vero**
(saltano senza fallire se `data/matches.json` manca). Un test nuovo va aggiunto a mano allo
script `test` in `package.json`.

Tre categorie, con scopi diversi:

- **unità** sul modello (`model.test.js`, `lambda-calibration.test.js`, …);
- **contratti di confine** — dove stanno quasi tutti i difetti storici: `dom-contract.test.js`
  (nessun id duplicato in una pagina, ogni id cercato dal JS esiste),
  `prediction-input-parity.test.js` (produzione = misura), `leakage-truncation.test.js` (R13),
  `player-context-contract.test.js` e i `tests/test_*.py` (pipeline Python ↔ JS sul dataset
  vero);
- **diagnostici** in `scripts/diag_*.mjs`, che rifanno la stessa verifica sui dati reali.

# Regole del progetto da non violare

Vengono dalle sessioni precedenti (`PROMPT-sessione-3.md` §2) e sono già costate difetti in
produzione:

- **R13 — nessun aggregato precalcolato che veda il futuro.** Ogni campo del payload usato dal
  modello dev'essere ricostruibile in avanti alla data della previsione, **oppure** escluso sia
  dalla produzione sia dal backtest. Non esiste la terza opzione «usato in produzione e ignorato
  in misura». `referee_stats` è confermato contaminante.
- **R14 — produzione e misura ricevono gli stessi input.** Una divergenza fra ciò che `app.js`
  passa e ciò che i backtest passano è un bug, non una configurazione. Un input nuovo si aggiunge
  a `MODEL_INPUT_DEFAULTS`, quindi a entrambi i lati, oppure a nessuno.
- **R15 — un difetto di calibrazione misurato non è evidenza che correggerlo paghi.** Nove
  tentativi su nove. Pre-registra soglia di successo e decisione in caso di fallimento *prima* di
  guardare l'esito.
- **Quando verifichi un meccanismo spento, accendilo nel test.** Ai valori neutri di produzione
  (`sharedDispersion`, `seasonQualityWeight`, `teamContext`, `refereeStats` = 0/null) un difetto
  armato dà verde.
- **Correggere i dati ha pagato ogni volta; aggiungere parametri mai** (dieci meccanismi provati,
  dieci respinti). Prima di proporre un parametro nuovo, leggi la lista «Da non riaprire» in
  `PROMPT-sessione-3.md` §6.

Documenti di riferimento: `README.md` (funzionamento e metodo), `MISTAKES.md` (difetti arrivati in
produzione), `docs/misure-riferimento.md` (ogni misura, numerata e citabile),
`BRIEF-v2.md` / `PROMPT-sessione-2.md` / `PROMPT-sessione-3.md` / `PROMPT-sessione-4.md`
(protocollo, in ordine di precedenza crescente).

`PROMPT-sessione-4.md` sposta l'asse del lavoro e va letto prima di proporre qualunque modifica al
modello: il peso ottimo della miscela fra modello e mercato e' **1.000 su training e su holdout**,
quindi un miglioramento del log loss non e' incassabile e il criterio di successo di un task non
puo' piu' essere quello. Le misure si riproducono con `node scripts/diag_market_execution.mjs`.
