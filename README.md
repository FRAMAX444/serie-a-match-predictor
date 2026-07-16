# Serie A Matchday Predictor — GitHub Pages

Web app per prevedere **tutta una giornata di Serie A** con un solo input: il numero della giornata. Il modello gira nel browser. Le impostazioni grafiche e i valori predefiniti possono essere pubblicati globalmente da una pagina amministrativa protetta con Firebase Authentication e Firestore.

## Esperienza utente

- selezione della giornata e calcolo simultaneo di tutte le partite;
- squadra preferita evidenziata con card dedicata e riepilogo in alto;
- click su qualsiasi partita o squadra per aprire probabilità, xG e risultati esatti;
- layout responsive ottimizzato per mobile e desktop;
- stesso cutoff pre-giornata per tutte le gare, così gli anticipi non contaminano le previsioni delle partite successive;
- configurazione globale in tempo reale di sfondo, colori, testi e valori predefiniti.

## Admin page

`admin.html` contiene un pannello senza registrazione pubblica. Un utente può salvare le impostazioni soltanto quando:

1. ha effettuato l'accesso con email e password tramite Firebase Authentication;
2. esiste il documento Firestore `admins/<UID>` con il campo `enabled: true`;
3. le regole di `firestore.rules` sono state pubblicate.

Dal pannello è possibile modificare:

- immagine HTTPS dello sfondo e relativa opacità;
- colori principali, sfondo e gradiente della testata;
- titolo, descrizione e avviso globale;
- squadra da evidenziare;
- finestra dati ed emivita predefinite;
- visibilità della qualità dati e delle quote teoriche.

Le modifiche vengono salvate nel documento `public/settings`. Il sito pubblico lo legge in tempo reale; se Firebase non è configurato o non è raggiungibile, continua a funzionare con i valori locali e l'ultima configurazione memorizzata nel browser.

## Configurazione Firebase

### 1. Crea e registra la web app

Crea un progetto nella Firebase Console e registra una web app. Copia il relativo oggetto di configurazione in `firebase-config.js`:

```js
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: "...",
  authDomain: "...firebaseapp.com",
  projectId: "...",
  appId: "...",
});
```

La configurazione web Firebase è pubblica per definizione: la protezione effettiva è fornita da Authentication e dalle Security Rules. Non inserire password, service account o chiavi private nella repository.

### 2. Abilita accesso email/password

In Firebase Authentication abilita il provider **Email/Password** e crea gli account delle persone autorizzate. È consigliato configurare una password policy forte e disabilitare qualunque registrazione pubblica nell'applicazione.

### 3. Crea gli amministratori

Per ogni account autorizzato copia il suo UID dalla sezione Authentication e crea in Firestore:

```text
admins/<UID>
  enabled: true
```

Per revocare l'accesso imposta `enabled: false`, elimina il documento oppure disabilita l'account Authentication.

### 4. Pubblica le regole Firestore

Con Firebase CLI:

```bash
npx firebase-tools login
npx firebase-tools use --add
npx firebase-tools deploy --only firestore:rules
```

Le regole consentono a tutti di leggere solo `public/settings`; la scrittura è riservata agli UID presenti nella collezione `admins`. Tutti gli altri documenti sono negati per default.

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

L'import Understat è best-effort: un errore non blocca l'aggiornamento dei risultati.

## Avvio locale

```bash
python -m http.server 8000
```

Aprire `http://localhost:8000`. Il pannello è disponibile su `http://localhost:8000/admin.html`.

## Test

```bash
npm test
npm run check
python -m py_compile scripts/update_data.py
```

## Deploy GitHub Pages

Il workflow `pages.yml` esegue i test e pubblica il sito. Il workflow giornaliero aggiorna il dataset e un nuovo commit attiva automaticamente un altro deploy. Firebase resta un servizio esterno e non richiede di spostare il sito da GitHub Pages.

## Limiti

Il modello è probabilistico e non garantisce risultati. Quote di mercato, condizioni meteo, cambi di allenatore, tattica, formazioni ufficiali e notizie dell'ultimo minuto possono contenere informazioni aggiuntive. Non utilizzare il progetto come promessa di rendimento economico.

## Licenza e attribuzione

Codice MIT. I dati restano soggetti alle condizioni e attribuzioni delle fonti: Football-Data.co.uk e Understat.
