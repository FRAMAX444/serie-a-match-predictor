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

L'interfaccia è responsive per mobile e desktop. La competizione predefinita può essere salvata nelle impostazioni personali e viene riaperta automaticamente.

## Dati usati

`scripts/update_uefa_data.py` aggiorna il dataset quattro volte al giorno e usa `scripts/update_europe_data.py` come pipeline di base.

La pipeline:

1. scarica calendario e risultati di Champions, Europa League e Conference League dall'API pubblica ufficiale UEFA;
2. usa i feed ESPN come fallback europeo e come fonte per i campionati nazionali disponibili;
3. identifica automaticamente le squadre presenti nella stagione target e i relativi codici paese UEFA;
4. individua tutti i campionati nazionali pertinenti alle federazioni rappresentate;
5. normalizza i nomi dei club per collegare correttamente dati UEFA, ESPN e Football-Data;
6. conserva soltanto le partite nazionali dei club europei, evitando di appesantire il dataset con gare irrilevanti;
7. usa Football-Data.co.uk per statistiche, tiri e quote quando il campionato è supportato;
8. arricchisce con xG Understat i principali campionati supportati;
9. collega campionati diversi attraverso un Elo globale aggiornato anche con le partite UEFA.

I campionati nazionali vengono quindi usati per forma, riposo, rendimento casa/trasferta, finalizzazione, disciplina ed Elo, ma non compaiono nel menu delle previsioni. La copertura mancante di alcuni campionati minori viene dichiarata in `coverage.teams_without_domestic_feed` e compensata con storico UEFA, Elo e prior di forza del campionato.

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

## Admin locale

`admin.html` usa un controllo locale con username e password. La password viene confrontata tramite un hash SHA-256 incorporato nel JavaScript e non è salvata in chiaro.

Questo controllo non costituisce sicurezza reale: il progetto è una web app statica pubblica e chiunque possa leggere o modificare il codice nel browser può aggirarlo. Non usare il pannello per proteggere segreti o dati sensibili.

Dal pannello si possono salvare, esclusivamente nel browser corrente:

- titolo e avviso locale;
- colori e sfondo HTTPS;
- squadra da evidenziare;
- finestra temporale e recenza del modello;
- visibilità della qualità dati e delle quote teoriche;
- preferenze locali da applicare al predictor.

Le pagine disponibili sono:

- `index.html`: pronostici europei;
- `settings.html`: preferenze personali e competizione predefinita;
- `admin.html`: configurazione locale protetta solo lato browser.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
python -m py_compile scripts/update_europe_data.py scripts/update_uefa_data.py
npm test
npm run check
```

I test coprono il catalogo multi-competizione, il cutoff comune, le baseline UEFA separate, il modello cross-campionato e la validazione delle impostazioni globali.

## Aggiornamento e deploy

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno;
- `.github/workflows/pages.yml` valida e pubblica GitHub Pages;
- `.github/workflows/validate-pr.yml` verifica ogni pull request e richiede che la pipeline riesca a costruire un dataset reale dalle fonti pubbliche.

## Limiti

Le previsioni sono probabilistiche. Formazioni ufficiali, infortuni, squalifiche, meteo, viaggi, tattica e notizie dell'ultimo minuto possono aggiungere informazione non presente nelle fonti gratuite. Il progetto non costituisce una promessa di rendimento economico.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: UEFA public match API, ESPN, Football-Data.co.uk e Understat.
