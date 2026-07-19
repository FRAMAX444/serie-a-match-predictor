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
5. apri una partita per vedere punteggi esatti, probabilità 1X2, xG, Over 2.5, BTTS e confronto degli indicatori principali.

L'interfaccia è responsive e conserva nel browser competizione preferita, squadra evidenziata, colori e parametri di recenza.

## Dataset

`scripts/update_top5_data.py` aggiorna `data/matches.json` usando fonti pubbliche e conserva soltanto i dati necessari:

- calendari e risultati delle coppe dall'API pubblica UEFA, con ESPN come fallback;
- calendari e risultati dei Big Five da ESPN;
- statistiche di tiro da Football-Data.co.uk;
- xG Understat quando disponibile;
- fallback xG prudente basato su tiri e tiri in porta.

Il dataset contiene:

- `competitions`: le tre coppe UEFA e i cinque campionati, con fixture, turni, paese e logo;
- `matches`: storico usato dal modello;
- `domestic_leagues`: elenco fisso dei Big Five selezionabili;
- `training_support_leagues`: eventuali campionati nascosti usati soltanto per la forma nazionale dei club UEFA;
- `coverage`, `source_health` e `sources`: indicatori di copertura.

Restano esclusi dal flusso attivo dati giocatori, probabili formazioni, trasferimenti, indisponibilità, quote di mercato, possesso e disciplina.

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

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test e backtest

```bash
python -m py_compile scripts/update_europe_data.py scripts/update_uefa_data.py scripts/update_top5_data.py
npm test
npm run check
npm run backtest
```

I test verificano catalogo Big Five + UEFA, esclusione dei campionati minori, cutoff comune, normalizzazione delle probabilità, invariabilità dei pronostici Big Five dopo l'aggiunta dei dati europei e le nuove regressioni di calibrazione venue-neutral/xG-Elo.

Il backtest usa soltanto informazioni disponibili prima di ogni gara e riporta log loss, Brier multiclass, Ranked Probability Score e accuracy. È possibile limitare l'analisi, per esempio:

```bash
npm run backtest -- --competition ita.1 --since 2025-08-01 --max 500
```

## Aggiornamento e deploy

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno;
- `.github/workflows/validate-pr.yml` valida JavaScript, test e costruzione del dataset;
- `.github/workflows/pages.yml` pubblica GitHub Pages.

## Limiti

Le previsioni sono probabilistiche e non includono notizie dell'ultimo minuto, formazioni ufficiali, infortuni, meteo o informazioni tattiche non presenti nelle fonti pubbliche. Il progetto non costituisce una promessa di rendimento economico.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: UEFA public match API, ESPN public scoreboards, Football-Data.co.uk e Understat.
