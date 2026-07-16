# Top Five European Match Predictor

Web app statica per prevedere le partite dei cinque maggiori campionati europei:

- Premier League;
- LaLiga;
- Serie A;
- Bundesliga;
- Ligue 1.

Le coppe UEFA e i campionati minori non sono selezionabili e non vengono usati dal modello.

## Flusso utente

1. scegli uno dei cinque campionati supportati;
2. seleziona il turno;
3. scegli facoltativamente una squadra da evidenziare;
4. premi **Calcola**;
5. apri una partita per vedere punteggi esatti, probabilità 1X2, xG, Over 2.5, BTTS e confronto degli indicatori principali.

L'interfaccia è responsive e conserva nel browser lega preferita, squadra evidenziata, colori e parametri di recenza.

## Dataset

`scripts/update_top5_data.py` aggiorna `data/matches.json` usando fonti pubbliche e conserva soltanto i dati necessari:

- calendario e risultati ESPN;
- statistiche di tiro da Football-Data.co.uk;
- xG Understat quando disponibile;
- fallback xG prudente basato su tiri e tiri in porta.

Il dataset contiene soltanto:

- `competitions`: i cinque campionati con fixture, turni, paese e logo;
- `matches`: storico usato dal modello;
- `domestic_leagues`: elenco fisso dei campionati supportati;
- `coverage`, `source_health` e `sources`: indicatori di copertura.

Sono stati rimossi dal flusso attivo dati giocatori, probabili formazioni, trasferimenti, indisponibilità, quote di mercato, possesso e disciplina.

## Modello 4.0 Top Five Core

Il modello usa esclusivamente segnali pre-partita stabili e disponibili in modo omogeneo:

- gol, xG e xGA recenti;
- tiri e tiri in porta;
- forma recente in punti per partita;
- rendimento casa/trasferta;
- Elo aggiornato cronologicamente;
- giorni di riposo;
- baseline specifica del campionato;
- Poisson con correzione Dixon–Coles per i punteggi bassi.

Tutte le partite dello stesso turno condividono il medesimo cutoff precedente alla prima gara, evitando leakage tra anticipi e partite successive.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
python -m py_compile scripts/update_europe_data.py scripts/update_top5_data.py
npm test
npm run check
```

I test verificano il filtro ai Big Five, il catalogo campionati, il cutoff comune e la normalizzazione delle probabilità.

## Aggiornamento e deploy

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno;
- `.github/workflows/validate-pr.yml` valida JavaScript, test e costruzione del dataset;
- `.github/workflows/pages.yml` pubblica GitHub Pages.

## Limiti

Le previsioni sono probabilistiche e non includono notizie dell'ultimo minuto, formazioni ufficiali, infortuni, meteo o informazioni tattiche non presenti nelle fonti pubbliche. Il progetto non costituisce una promessa di rendimento economico.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: ESPN public scoreboards, Football-Data.co.uk e Understat.
