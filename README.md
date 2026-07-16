# European Cups Match Predictor

Web app statica per prevedere i turni delle tre competizioni UEFA per club:

- UEFA Champions League;
- UEFA Europa League;
- UEFA Conference League.

Il menu mostra soltanto queste coppe. I campionati nazionali non sono pronosticabili: vengono scaricati e usati esclusivamente come dati di forma per le squadre presenti nelle competizioni europee.

## Flusso utente

1. seleziona la competizione europea;
2. seleziona il turno dal menu a tendina;
3. seleziona la squadra da evidenziare;
4. premi **Calcola** per ottenere tutte le partite del turno;
5. apri una partita per vedere risultati esatti, 1X2, xG, Over 2.5, BTTS, Elo e confronto di forma.

L'interfaccia è responsive per mobile e desktop.

## Dati usati

`scripts/update_europe_data.py` aggiorna il dataset quattro volte al giorno.

La pipeline:

1. scarica calendario e risultati di Champions, Europa League e Conference League dai feed pubblici ESPN;
2. identifica automaticamente le squadre presenti nella stagione target;
3. individua i campionati nazionali che contengono quelle squadre;
4. conserva soltanto le partite nazionali dei club europei, evitando di appesantire il dataset con campionati irrilevanti;
5. usa Football-Data.co.uk per statistiche, tiri e quote quando il campionato è supportato;
6. usa ESPN come fonte di fallback per i campionati non coperti dai CSV;
7. arricchisce con xG Understat i campionati supportati;
8. collega campionati diversi attraverso un Elo globale aggiornato anche con le partite UEFA.

I campionati nazionali vengono quindi usati per forma, riposo, rendimento casa/trasferta, finalizzazione, disciplina ed Elo, ma non compaiono nel menu delle previsioni.

## Modello 3.0 Europa

Il modello usa:

- forma recente nazionale ed europea, con peso maggiore alle gare UEFA;
- xG/xGA reali quando disponibili e proxy prudente negli altri casi;
- tiri, tiri in porta, possesso, finalizzazione e disciplina;
- rendimento casa/trasferta;
- giorni di riposo e congestione del calendario;
- Elo globale con connessioni tra campionati tramite le coppe;
- informazioni verificate in `data/context_overrides.json`;
- Poisson con correzione Dixon–Coles per i punteggi bassi.

Ogni coppa usa una propria baseline gol storica. Le medie dei campionati nazionali non vengono usate direttamente come media di Champions o Europa League.

Tutte le partite dello stesso turno condividono il medesimo cutoff precedente alla prima gara, evitando leakage tra anticipi e partite successive.

## Struttura del dataset

`data/matches.json` contiene:

- `competitions`: le tre coppe con fixture, turni e calendario;
- `matches`: risultati UEFA storici e partite nazionali delle sole squadre partecipanti;
- `team_context`: Elo e override verificati;
- `domestic_leagues`: i campionati individuati automaticamente come rilevanti;
- `coverage` e `source_health`: indicatori di copertura e qualità delle fonti.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
python -m py_compile scripts/update_europe_data.py
npm test
npm run check
```

## Aggiornamento e deploy

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno;
- `.github/workflows/pages.yml` valida e pubblica GitHub Pages;
- `.github/workflows/validate-pr.yml` verifica ogni pull request e prova le fonti pubbliche senza bloccare la CI in caso di indisponibilità temporanea.

## Limiti

Le previsioni sono probabilistiche. Formazioni ufficiali, infortuni, squalifiche, meteo, viaggi, tattica e notizie dell'ultimo minuto possono aggiungere informazione non presente nelle fonti gratuite. Il progetto non costituisce una promessa di rendimento economico.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: ESPN, Football-Data.co.uk e Understat.
