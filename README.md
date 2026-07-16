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

Nessuna chiave API è necessaria per i dati sportivi. Le fonti esterne sono best-effort e la provenienza viene salvata nel payload in `sources` e `source_health`.

## Admin page e impostazioni globali

`admin.html` permette agli account autorizzati di pubblicare una configurazione condivisa da tutti i visitatori. Il pannello usa Firebase Authentication con email/password e Firestore; il sito può restare su GitHub Pages.

Dal pannello è possibile cambiare:

- titolo della pagina e avviso globale;
- squadra da evidenziare;
- colori principali e immagine di sfondo HTTPS;
- opacità dello sfondo;
- finestra dati ed emivita del modello;
- visibilità della qualità dati e delle quote teoriche;
- quali preferenze devono essere obbligatorie per tutti.

Le impostazioni personali in `settings.html` continuano a funzionare quando l'amministratore non le rende obbligatorie. Il documento globale è `public/settings`; gli aggiornamenti vengono ricevuti in tempo reale e memorizzati anche in cache per il fallback offline.

### Configurazione Firebase

1. Crea un progetto nella Firebase Console e registra una web app.
2. Copia la configurazione pubblica della web app in `firebase-config.js`:

```js
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  appId: "...",
});
```

La configurazione web Firebase non è una password. Non inserire nella repository password, service account, chiavi private o file JSON amministrativi.

3. In **Authentication → Sign-in method** abilita **Email/Password**.
4. Crea da Firebase Console gli account delle persone che possono accedere alla pagina admin.
5. Per ogni account, copia il relativo UID e crea in Firestore:

```text
admins/<UID>
  enabled: true
```

La sola conoscenza di email e password non basta: il documento `admins/<UID>` deve essere presente e abilitato. Per revocare l'accesso imposta `enabled: false`, elimina il documento oppure disabilita l'account Authentication.

6. Pubblica le Security Rules incluse nella repository:

```bash
npx firebase-tools login
npx firebase-tools use --add
npx firebase-tools deploy --only firestore:rules
```

Le regole consentono la lettura pubblica soltanto di `public/settings`, permettono la scrittura esclusivamente agli UID amministratori e negano tutto il resto per impostazione predefinita.

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

Aprire `http://localhost:8000`. Le pagine di configurazione sono:

- `http://localhost:8000/settings.html` per le preferenze personali;
- `http://localhost:8000/admin.html` per le impostazioni globali.

## Test

```bash
npm test
npm run check
python -m py_compile scripts/update_data.py
```

I test coprono normalizzazione delle probabilità, cutoff comune, stagione target 2026/27, prior delle neopromosse, influenza del contesto rosa, blocco del leakage temporale e validazione delle impostazioni globali.

## Limiti

Le previsioni sono probabilistiche. Quote di mercato, meteo, tattica, formazioni ufficiali e notizie dell'ultimo minuto possono aggiungere informazione non presente nelle fonti gratuite. Il progetto non è una promessa di rendimento economico.

## Licenza e attribuzione

Codice MIT. I dati restano soggetti alle condizioni delle fonti: Football-Data.co.uk, Understat ed ESPN per il fallback calendario.
