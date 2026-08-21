# European Match Predictor

Web app statica per prevedere le partite delle principali competizioni europee.

## Competizioni selezionabili

Coppe UEFA:

- UEFA Champions League;
- UEFA Europa League;
- UEFA Conference League.

Campionati Big Five:

- Premier League;
- LaLiga;
- Serie A;
- Bundesliga;
- Ligue 1.

I campionati minori non compaiono nel selettore. Le sole partite nazionali dei club UEFA provenienti da altri campionati possono essere conservate come supporto interno alla forma e all'Elo delle coppe.

## Flusso utente

1. scegli una coppa o un campionato dal selettore compatto con logo;
2. seleziona il turno;
3. scegli facoltativamente una squadra da evidenziare;
4. premi **Calcola**;
5. apri una partita per vedere punteggi esatti, probabilità 1X2, xG, Over 2.5, BTTS e confronto degli indicatori principali (tab "Analisi"); tab "Dati extra" per contesto pre-partita (formazione/disponibilità/neopromosse, se disponibile), medie recenti di corner/cartellini/possesso (non ancora un input del modello, solo contesto storico) e tutta la rosa campionata per squadra con probabilità stimate di tiro/gol/assist/cartellino per QUESTA partita (ancorate al lambda già calcolato dal modello, non semplici medie storiche) insieme allo storico grezzo.

L'interfaccia è responsive e conserva nel browser competizione preferita, squadra evidenziata, colori e parametri di recenza.

## Dataset

`scripts/update_top5_data.py` aggiorna `data/matches.json` usando fonti pubbliche:

- calendari e risultati delle coppe dall'API pubblica UEFA, con ESPN come fallback;
- calendari e risultati dei Big Five da ESPN;
- statistiche di tiro, corner, cartellini, possesso e quote di chiusura (media di mercato, poi Bet365, poi Pinnacle) da Football-Data.co.uk;
- arbitro della partita, da Football-Data.co.uk;
- xG Understat quando la pagina lega espone ancora il blob `datesData`; fallback via l'endpoint JSON `getTeamData` (per-squadra, stesso schema dati, nessuna dipendenza extra) quando non lo espone più; fallback finale prudente basato su tiri e tiri in porta.

Il dataset contiene:

- `competitions`: le tre coppe UEFA e i cinque campionati, con fixture, turni, paese e logo;
- `matches`: storico usato dal modello, incluse quote/corner/cartellini/possesso/arbitro quando disponibili;
- `team_context`: formazione probabile, disponibilità e fattori neopromosse per squadra, se `scripts/enrich_competitions_players.py` è stato eseguito dopo `update_top5_data.py`;
- `referee_stats`: tendenze regolarizzate (shrinkage bayesiano) per arbitro;
- `domestic_leagues`: elenco fisso dei Big Five selezionabili;
- `coverage`, `source_health` e `sources`: indicatori di copertura.

La raccolta dati è volutamente limitata ai Big Five e alle tre coppe UEFA: niente più fetch per campionati minori (~40 leghe di supporto, la maggior parte delle chiamate ESPN per quelle falliva comunque con HTTP 400). Per le coppe UEFA questo significa che i club fuori dai Big Five (es. squadre di Eredivisie, Primeira Liga, Veikkausliiga...) partono con priori Elo meno informati, basandosi solo sulle partite giocate nella coppa stessa e non sul loro storico di campionato domestico — un compromesso deliberato a favore di un dataset più piccolo, veloce da rigenerare e senza rumore nei log.

Restano esclusi dal flusso attivo transfer window e notizie last-minute non presenti nelle fonti sopra; l'arbitro di una partita futura non è disponibile automaticamente da nessuna fonte usata qui (va fornito manualmente se lo conosci in anticipo, vedi sotto).

## Modello 5.0 Calibrated Recency + xG Elo

Il modello usa esclusivamente segnali pre-partita stabili e disponibili in modo omogeneo:

- gol, xG e xGA recenti;
- tiri e tiri in porta;
- forma recente in punti per partita;
- rendimento casa/trasferta;
- Elo aggiornato cronologicamente;
- giorni di riposo;
- baseline specifica della competizione;
- Poisson con correzione Dixon–Coles per i punteggi bassi.

La versione 5.0 aggiunge quattro correzioni validate con backtest temporale:

- le statistiche generali sono normalizzate contro una baseline neutrale, mentre i soli split casa/trasferta usano le rispettive medie di venue;
- la recenza è pesata in giorni di calendario, non soltanto per numero di partite;
- l'affidabilità cresce con shrinkage regolare e l'Elo decade lievemente dopo inattività prolungata;
- quando sono disponibili xG reali, l'aggiornamento Elo combina risultato e qualità della prestazione, riducendo il rumore dei singoli episodi.

Per i cinque campionati il filtro di training resta limitato esattamente ai Big Five, quindi l'aggiunta delle coppe non modifica i pronostici nazionali. Per le coppe, il modello combina storico UEFA e forma nazionale delle squadre partecipanti, mantenendo una baseline separata per ciascuna competizione quando il campione è sufficiente.

Tutte le partite dello stesso turno condividono il medesimo cutoff precedente alla prima gara, evitando leakage tra anticipi e partite successive.

### Segnali opzionali (di default nessun effetto sulle previsioni esistenti)

Tre input aggiuntivi, tutti spenti finché non li passi esplicitamente — attivarli non cambia nessuna previsione già calibrata:

- **`teamContext`**: formazione probabile/disponibilità/neopromosse per squadra (da `team_context` nel dataset, se `enrich_competitions_players.py` è stato eseguito). Passato automaticamente da `app.js` quando presente.
- **`hyperparameters`**: sovrascrive uno o più dei parametri di `DEFAULT_HYPERPARAMETERS` in `model.js` (rho di Dixon-Coles, esponenti attacco/difesa, divisore/clamp Elo, pesi momentum, soglie di riposo, sconto Elo per neopromosse). Vedi `npm run tune`.
- **`refereeHomeBias`**: scostamento nel tasso di vittorie casalinghe per uno specifico arbitro (da `referee_stats`). Nessuna fonte usata da questa pipeline conosce l'arbitro di una partita futura prima dell'annuncio: va passato a mano per una partita specifica, non è automatico.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test e backtest

```bash
python -m py_compile scripts/update_europe_data.py scripts/update_uefa_data.py scripts/update_top5_data.py scripts/understat_team_api.py scripts/enrich_competitions_players.py
npm run test:py
npm test
npm run check
npm run backtest
npm run backtest:market
npm run tune
```

I test verificano catalogo Big Five + UEFA, esclusione dei campionati minori, cutoff comune, normalizzazione delle probabilità, invariabilità dei pronostici Big Five dopo l'aggiunta dei dati europei, le regressioni di calibrazione venue-neutral/xG-Elo, `teamContext` (retrocompatibilità, direzione degli effetti, clamp) e gli iperparametri (deep-merge, cold-start neopromosse, bias arbitro).

Il backtest usa soltanto informazioni disponibili prima di ogni gara e riporta log loss, Brier multiclass, Ranked Probability Score e accuracy. È possibile limitare l'analisi, per esempio:

```bash
npm run backtest -- --competition ita.1 --since 2025-08-01 --max 500
```

`npm run backtest:market` confronta le stesse previsioni con le quote di chiusura de-vigate: è l'unico modo per sapere se il modello ha un vantaggio reale sul mercato, non solo un log loss basso preso da solo. Richiede che il dataset sia stato rigenerato dopo che `update_top5_data.py` conserva le quote (vedi sopra).

`npm run tune` cerca, per coordinate descent, una combinazione di iperparametri che migliori il backtest rispetto ai default. **Rischio di overfitting reale** con 16 dimensioni cercate su una sola finestra: valida sempre il risultato su un periodo successivo e non usato per il tuning prima di portarlo in produzione.

## Aggiornamento e deploy

Per rigenerare `data/matches.json` in locale (utile per verificare una correzione prima di spingerla su GitHub):

```bash
pip install -r requirements.txt
python scripts/update_top5_data.py --history-seasons 4
python scripts/enrich_competitions_players.py
```

Sovrascrive `data/matches.json` nella cartella corrente — nessun parametro `--target-season` necessario: viene calcolato da solo dalla data odierna (vedi `resolve_target_season`). Passa `--target-season 2728` solo per forzare una stagione diversa da quella corrente.

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno, poi arricchisce `team_context` con `enrich_competitions_players.py`; installa `requirements.txt` (solo `requests`, usata per lo scraping Understat con sessione/cookie persistenti — senza, l'endpoint AJAX di Understat risponde vuoto);
- `.github/workflows/validate-pr.yml` valida JavaScript, test e costruzione del dataset (smoke build con `--skip-understat`);
- `.github/workflows/pages.yml` pubblica GitHub Pages.

## Schedina

`schedina.html` genera, su richiesta esplicita (pulsante "Genera schedina", nessuna chiamata automatica), una combinazione di esiti 1X2 del prossimo turno di una lega scelta, verso una quota target, selezionata per massimizzare la probabilità combinata stimata dal modello tra le combinazioni che rientrano nella quota (tolleranza ±15%).

Le quote in tempo reale vengono richieste a [the-odds-api.com](https://the-odds-api.com/) (piano gratuito: 500 richieste/mese, nessuna carta) tramite una chiave personale, inserita e conservata solo nel browser (`localStorage`, mai nel repository). Il campionato su the-odds-api.com viene individuato dinamicamente interrogando il loro catalogo sport invece di usare uno `sport_key` fisso nel codice: se il match non è univoco, la pagina mostra le opzioni disponibili per una scelta manuale invece di indovinare.

`schedina.js` contiene la logica pura (selezione candidati, ricerca della combinazione ottimale, abbinamento nomi/date) testata in `tests/schedina.test.js`; il fetch delle quote live non è verificabile da questo ambiente di sviluppo (nessun accesso di rete a domini di quote) — verificato solo con una risposta simulata che replica lo schema documentato dell'API.

**Mercati sui singoli giocatori (opzionale, sperimentale)**: la casella "Includi anche marcatori" aggiunge candidati "marcatore in qualsiasi momento" per i giocatori più impattanti di ogni squadra, con probabilità stimate da `estimatePlayerMarkets` in `model.js` (ancorate al lambda che il modello calcola già per quella partita, non semplici medie storiche — vedi `tests/player-markets.test.js`). `estimatePlayerMarkets` calcola anche `shotProbability`/`multiShotProbability` (almeno 1 e almeno 2 tiri) e `cardProbability`, mostrate nella tab "Dati extra" ma non ancora collegate a `schedina.js`; metodologia e validazione Monte Carlo in [`docs/player-probability-study.md`](docs/player-probability-study.md) (`npm run study:players` per rieseguirla). Le quote reali richiedono `regions=us` su the-odds-api.com (coverage player-prop per le Big Five è lì, non su `eu`) e una chiamata per evento: quando non disponibili (piano non le include, mercato assente per quell'evento) la selezione usa la quota equa del modello, etichettata "stima" nell'interfaccia invece di spacciarla per una quota di mercato. Una selezione sul marcatore e una sul risultato della STESSA partita non vengono mai combinate nella stessa schedina (stessa `fixtureIndex`, `bestAccumulator` ne sceglie al più una): eviterebbe di trattare come indipendenti due eventi in realtà correlati.

Nota matematica mostrata nell'interfaccia: ogni selezione aggiuntiva in una schedina multipla moltiplica il margine del bookmaker oltre che le quote, rendendola la struttura di scommessa meno favorevole al giocatore anche quando ogni singola quota è equa. La probabilità mostrata è la stima del modello, non una garanzia.

## Limiti

Le previsioni sono probabilistiche e non includono notizie dell'ultimo minuto, formazioni ufficiali confermate, infortuni non curati manualmente, meteo o informazioni tattiche non presenti nelle fonti pubbliche. Gli slug Understat usati dal fallback `getTeamData` sono dedotti dalla convenzione nota del sito: controllare i log al primo run reale (segnalano esplicitamente le squadre con 0 partite risolte). Il progetto non costituisce una promessa di rendimento economico; le quote di chiusura sono tra gli stimatori più efficienti disponibili, batterle in modo sistematico e statisticamente significativo è difficile per costruzione.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: UEFA public match API, ESPN public scoreboards, Football-Data.co.uk e Understat.
