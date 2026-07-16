# Serie A Matchday Predictor — GitHub Pages

Web app statica per prevedere **tutta una giornata di Serie A** con un solo input: il numero della giornata. Il calcolo avviene interamente nel browser; non esiste un backend applicativo e non vengono inviati dati dell'utente.

## Esperienza utente

- selezione della giornata e calcolo simultaneo di tutte le partite;
- Roma evidenziata con card dedicata e riepilogo in alto;
- click su qualsiasi partita o squadra per aprire probabilità, xG e risultati esatti;
- layout responsive ottimizzato per mobile e desktop;
- stesso cutoff pre-giornata per tutte le gare, così gli anticipi non contaminano le previsioni delle partite successive.

## Modello

Il browser ricostruisce lo stato delle squadre usando solo partite precedenti al cutoff della giornata. La stima combina:

1. forza offensiva e difensiva recente con shrinkage verso la media del campionato;
2. xG/xGA reali quando disponibili, altrimenti proxy da tiri e tiri in porta;
3. forma a 3, 5 e 10 partite e rendimento casa/trasferta;
4. Elo dinamico con vantaggio casa;
5. possesso, volume di tiro, finalizzazione e disciplina recente;
6. giorni di riposo e penalità leggere per calendario congestionato;
7. matrice di Poisson con correzione Dixon–Coles per i punteggi bassi;
8. indicatore di qualità dati basato su profondità, freschezza e copertura xG.

Per squadre neopromosse o con storico insufficiente il modello usa un prior prudente vicino alla media di lega, riducendo la qualità dati mostrata nell'interfaccia.

## Dati e calendario

`data/matches.json` contiene risultati storici e, quando disponibile, il calendario della stagione più recente. Ogni giorno `.github/workflows/update-data.yml` esegue `scripts/update_data.py`:

- scarica le stagioni recenti da Football-Data.co.uk;
- prova ad arricchire risultati e calendario con Understat;
- assegna la giornata alle fixture;
- usa un fallback ricostruito dai risultati quando il calendario esterno non è disponibile;
- aggiorna il JSON soltanto se i dati cambiano.

Nessuna chiave API è necessaria. L'import Understat è best-effort: un errore non blocca l'aggiornamento dei risultati.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
npm test
npm run check
python -m py_compile scripts/update_data.py
```

## Deploy GitHub Pages

Il workflow `pages.yml` esegue i test e pubblica il sito. Il workflow giornaliero aggiorna il dataset e un nuovo commit attiva automaticamente un altro deploy.

## Limiti

Il modello è probabilistico e non garantisce risultati. Quote di mercato, condizioni meteo, cambi di allenatore, tattica, formazioni ufficiali e notizie dell'ultimo minuto possono contenere informazioni aggiuntive. Non utilizzare il progetto come promessa di rendimento economico.

## Licenza e attribuzione

Codice MIT. I dati restano soggetti alle condizioni e attribuzioni delle fonti: Football-Data.co.uk e Understat.
