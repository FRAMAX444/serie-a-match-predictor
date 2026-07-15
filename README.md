# Serie A Match Predictor — GitHub Pages

Web app statica per stimare una partita di Serie A scegliendo squadra di casa, squadra ospite e data. Il pronostico viene calcolato interamente nel browser: non esiste un backend e non vengono inviate informazioni dell'utente a un server applicativo.

## Output

- probabilità vittoria casa, pareggio e vittoria ospite;
- risultato esatto più probabile e top 10 punteggi;
- gol attesi, Over 2.5 e Goal/BTTS;
- confronto su forma, xG/xGA, possesso, tiri in porta ed Elo;
- correzioni pre-partita per assenze in attacco/difesa e forza della formazione.

## Modello

Il browser ricostruisce lo stato delle squadre soltanto con partite precedenti alla data scelta. Di default usa gli ultimi 18 mesi e un decadimento esponenziale con emivita di 120 giorni. Combina:

1. forza offensiva e difensiva recente;
2. xG e xGA delle ultime gare;
3. tiri in porta e possesso;
4. rendimento casa/trasferta;
5. rating Elo e forma punti;
6. matrice di Poisson per i punteggi esatti.

Quando gli xG reali non sono disponibili, l'interfaccia lo segnala e usa un proxy basato su tiri e tiri in porta. Il possesso mancante viene stimato con un proxy di attività. Gli infortuni non vengono inventati: sono controlli manuali pre-partita.

## Dati e aggiornamento

`data/matches.json` contiene il dataset statico. Ogni giorno `.github/workflows/update-data.yml` esegue `scripts/update_data.py`:

- scarica le stagioni recenti da Football-Data.co.uk;
- prova ad arricchire le partite con gli xG di Understat;
- aggiorna il JSON soltanto se i dati cambiano.

Nessuna chiave API è necessaria. Lo scraping Understat è best-effort: un errore non blocca l'aggiornamento dei risultati.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`.

## Test

```bash
npm test
```

## Deploy GitHub Pages

1. creare una repository pubblica e caricare questi file sul branch `main`;
2. in **Settings → Pages**, scegliere **GitHub Actions** come sorgente;
3. eseguire il workflow **Deploy GitHub Pages**, oppure effettuare un push su `main`.

Il workflow `pages.yml` esegue i test e pubblica il sito. Il workflow giornaliero aggiorna il dataset e il nuovo commit attiva automaticamente un altro deploy.

## Limiti

Il modello è probabilistico e non garantisce risultati. Quote di mercato, condizioni meteo, cambi di allenatore, tattica e notizie dell'ultimo minuto possono contenere informazioni aggiuntive. Non utilizzare il progetto come promessa di rendimento economico.

## Licenza e attribuzione

Codice MIT. I dati restano soggetti alle condizioni e attribuzioni delle fonti: Football-Data.co.uk e Understat.
