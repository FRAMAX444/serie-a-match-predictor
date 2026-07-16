# Serie A Matchday Predictor 2026/27

Web app statica per prevedere **tutta una giornata della Serie A 2026/27**. Il calcolo avviene nel browser, mentre GitHub Actions aggiorna automaticamente calendario, risultati, xG, rating Elo e contesto delle rose durante tutta la stagione.

## Cosa cambia per la stagione 2026/27

- la stagione target è esplicitamente `2627`, anche durante la pausa estiva;
- il calendario viene cercato prima su Understat e poi sul feed pubblico ESPN; se le fonti sono temporaneamente indisponibili viene conservato l'ultimo calendario 2026/27 valido, senza inventare fixture;
- il dataset viene aggiornato quattro volte al giorno e ogni deploy tenta comunque un refresh;
- le previsioni di una giornata usano un unico cutoff precedente alla prima partita del turno;
- risultati e contesto successivi al cutoff non vengono utilizzati, evitando leakage sulle giornate già disputate.

## Segnali usati dal modello

Il modello 2.0 combina:

1. attacco e difesa recenti con shrinkage verso la media di Serie A;
2. xG/xGA Understat, oppure proxy trasparente da tiri e tiri in porta;
3. forma a 3, 5 e 10 gare, rendimento casa/trasferta, possesso e finalizzazione;
4. Elo dinamico con vantaggio casa e continuità tra Serie B e Serie A per le neopromosse;
5. forza implicita delle quote storiche disponibili nei CSV, usata come segnale debole e non come verità;
6. prior di promozione costruiti sull'ultima stagione di Serie B;
7. forza offensiva e creatività della rosa, continuità, nuovi giocatori e partenze rilevate nei dati Understat;
8. disponibilità, forza formazione e cambi allenatore inseribili solo tramite override verificati;
9. riposo, congestione del calendario e disciplina;
10. Poisson con correzione Dixon–Coles per i punteggi bassi;
11. qualità dati basata su profondità, freschezza, copertura xG e affidabilità del contesto rosa.

Il peso dei dati sui giocatori è volutamente contenuto: migliora il prior pre-stagionale e reagisce ai nuovi ingressi, ma non sovrascrive la forma reale osservata sul campo.

## Aggiornamento continuo

`.github/workflows/update-data.yml` viene eseguito alle 02:23, 08:23, 14:23 e 20:23 UTC. `scripts/update_data.py`:

- scarica cinque stagioni di Serie A da Football-Data.co.uk;
- scarica Serie B per stimare correttamente le neopromosse;
- importa calendario, xG e produzione giocatori da Understat;
- usa il feed pubblico ESPN come fallback del calendario;
- calcola un Elo aggiornato cronologicamente;
- aggrega i giocatori chiave, i nuovi giocatori rilevati, continuità e creatività della rosa;
- conserva il precedente calendario 2026/27 se le fonti esterne falliscono;
- pubblica `data/matches.json` solo dopo i controlli automatici.

Nessuna chiave API è necessaria. Le fonti esterne sono best-effort e la provenienza viene salvata nel payload in `sources` e `source_health`.

## Informazioni verificate dell'ultimo minuto

Infortuni, squalifiche, probabili formazioni, trasferimenti appena ufficializzati e cambi allenatore non devono essere dedotti da rumor. Possono essere aggiunti in `data/context_overrides.json`:

```json
{
  "teams": {
    "Roma": {
      "as_of": "2026-08-20",
      "availability_attack": 0.94,
      "availability_defense": 1.0,
      "lineup_strength": 0.98,
      "manager_change_days": null,
      "arrivals": [
        { "name": "Nome giocatore", "position": "F", "impact": 0.03 }
      ],
      "notes": ["Fonte ufficiale del club"]
    }
  }
}
```

Gli override vengono applicati soltanto se `as_of` è precedente al cutoff della partita.

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

I test coprono normalizzazione delle probabilità, cutoff comune, stagione target 2026/27, prior delle neopromosse, influenza del contesto rosa e blocco del leakage temporale.

## Limiti

Le previsioni sono probabilistiche. Quote di mercato, meteo, tattica, formazioni ufficiali e notizie dell'ultimo minuto possono aggiungere informazione non presente nelle fonti gratuite. Il progetto non è una promessa di rendimento economico.

## Licenza e attribuzione

Codice MIT. I dati restano soggetti alle condizioni delle fonti: Football-Data.co.uk, Understat ed ESPN per il fallback calendario.
