# Multi-League Match Predictor

Web app statica per prevedere le partite delle competizioni calcistiche presenti nel dataset, incluse:

- UEFA Champions League;
- UEFA Europa League;
- UEFA Conference League;
- i campionati nazionali supportati e rilevanti per le squadre europee della stagione.

## Flusso utente

1. all'apertura scegli la competizione da una schermata con nome e logo;
2. le competizioni sono ordinate usando la lega e la squadra preferite salvate nel browser;
3. seleziona il turno e, facoltativamente, la squadra da evidenziare;
4. premi **Calcola** per ottenere tutte le partite del turno;
5. apri una partita per vedere risultati esatti, 1X2, xG, Over 2.5, BTTS, Elo, forma, giocatori chiave e probabili formazioni.

Quando scegli una competizione che contiene la squadra preferita, l'app apre automaticamente il turno della sua prossima partita disponibile e calcola il pronostico.

L'interfaccia è responsive per mobile e desktop. In `settings.html` puoi scegliere la competizione predefinita, riordinare le leghe e impostare squadra e colori preferiti.

## Dati usati

La generazione avviene in due passaggi:

1. `scripts/update_uefa_data.py` costruisce il dataset di base usando l'API pubblica UEFA, ESPN, Football-Data.co.uk e Understat;
2. `scripts/enrich_competitions_players.py` aggiunge calendari nazionali supportati, loghi, statistiche giocatori e probabili formazioni.

La pipeline:

1. scarica calendario e risultati di Champions, Europa League e Conference League dall'API pubblica UEFA;
2. usa i feed ESPN come fallback europeo e come fonte per i campionati nazionali disponibili;
3. identifica automaticamente le squadre presenti nella stagione target e i relativi codici paese UEFA;
4. individua i campionati nazionali pertinenti alle federazioni rappresentate;
5. normalizza i nomi dei club per collegare dati UEFA, ESPN e Football-Data;
6. usa Football-Data.co.uk per statistiche, tiri e quote quando il campionato è supportato;
7. arricchisce con xG Understat i principali campionati supportati;
8. costruisce un Elo globale aggiornato con gare nazionali e UEFA;
9. legge i riepiloghi partita ESPN per stimare titolari recenti, continuità, rendimento e probabile undici;
10. conserva sempre un fallback: l'assenza temporanea del feed giocatori non blocca l'aggiornamento principale.

## Modello e contesto giocatori

Il modello usa:

- forma recente nazionale ed europea, con peso maggiore alle gare UEFA;
- xG/xGA reali quando disponibili e proxy prudente negli altri casi;
- tiri, tiri in porta, possesso, finalizzazione e disciplina;
- rendimento casa/trasferta;
- giorni di riposo e congestione del calendario;
- Elo globale con connessioni tra campionati tramite le coppe;
- disponibilità, continuità della rosa e forza della probabile formazione;
- contributo individuale recente derivato da presenze, titolarità, minuti, gol, assist e rating disponibili;
- informazioni verificate in `data/context_overrides.json`;
- Poisson con correzione Dixon–Coles per i punteggi bassi.

I dati individuali non sostituiscono le statistiche di squadra: producono fattori conservativi di attacco, creatività e forza formazione che vengono combinati con lo storico complessivo. Le formazioni sono stime basate sulle ultime gare e non formazioni ufficiali.

Tutte le partite dello stesso turno condividono il medesimo cutoff precedente alla prima gara, evitando leakage tra anticipi e partite successive.

## Struttura del dataset

`data/matches.json` contiene:

- `competitions`: tutte le competizioni selezionabili, con fixture, turni, paese e logo quando disponibile;
- `matches`: risultati storici usati dal modello;
- `team_context`: Elo, disponibilità, indice formazione e override verificati;
- `player_context`: giocatori recenti, probabile formazione, modulo e affidabilità della stima;
- `domestic_leagues`: campionati individuati automaticamente come rilevanti;
- `coverage` e `source_health`: indicatori di copertura e qualità delle fonti.

## Preferenze locali

Le preferenze sono salvate nella cache del browser tramite `localStorage`:

- competizione predefinita;
- ordine delle competizioni;
- squadra preferita;
- palette della squadra;
- parametri di recenza del modello;
- sfondo personale.

## Admin locale

`admin.html` usa un controllo locale con un solo username autorizzato e una password verificata tramite hash SHA-256. La password non è presente in chiaro nel JavaScript.

Il pannello controlla esplicitamente la disponibilità di WebCrypto e mostra un errore utile quando la pagina non è servita in un contesto compatibile, per esempio fuori da HTTPS o localhost.

Questo controllo non costituisce sicurezza reale: il progetto è una web app statica pubblica e chiunque possa leggere o modificare il codice nel browser può aggirarlo. Non usare il pannello per proteggere segreti o dati sensibili.

Dal pannello si possono salvare, esclusivamente nel browser corrente:

- titolo e avviso locale;
- colori e sfondo HTTPS;
- squadra da evidenziare;
- finestra temporale e recenza del modello;
- visibilità della qualità dati e delle quote teoriche;
- preferenze locali da applicare al predictor.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
python -m py_compile scripts/update_europe_data.py scripts/update_uefa_data.py scripts/enrich_competitions_players.py
npm test
npm run check
```

I test coprono catalogo multi-competizione, prossima partita della squadra preferita, cutoff comune, baseline, contesto rosa e verifica dell'autenticazione admin.

## Aggiornamento e deploy

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno;
- `.github/workflows/pages.yml` valida e pubblica GitHub Pages;
- `.github/workflows/validate-pr.yml` verifica ogni pull request e costruisce un dataset reale dalle fonti pubbliche;
- il controllo PR usa `--skip-player-data` nello smoke test per limitare il numero di richieste, mentre l'aggiornamento pianificato esegue l'arricchimento completo.

## Limiti

Le previsioni sono probabilistiche. Le probabili formazioni sono inferenze e possono differire dalle scelte ufficiali, soprattutto in presenza di rotazioni, infortuni, squalifiche o notizie dell'ultimo minuto. Il progetto non costituisce una promessa di rendimento economico.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: UEFA public match API, ESPN, Football-Data.co.uk e Understat.
