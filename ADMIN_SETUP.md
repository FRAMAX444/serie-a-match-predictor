# Configurazione accessi amministratore

La pagina `admin.html` accetta username leggibili, ma continua a usare Firebase Authentication e Firestore per la sicurezza effettiva. Le password non devono mai essere salvate nella repository, che è pubblica.

## Username configurati

| Username | Email tecnica Firebase |
| --- | --- |
| `RC25M` | `rc25m@serie-a-predictor.invalid` |
| `FraMar` | `framar@serie-a-predictor.invalid` |
| `MassGall` | `massgall@serie-a-predictor.invalid` |
| `LucSco` | `lucsco@serie-a-predictor.invalid` |

## Creazione degli account

1. In Firebase Console apri **Authentication → Users**.
2. Crea un utente per ciascuna email tecnica della tabella.
3. Imposta manualmente una password forte e diversa per ogni account. Non inserire le password in file GitHub, JavaScript o documentazione.
4. Copia l'UID Firebase di ogni utente.
5. In Firestore crea il documento `admins/<UID>` con:

```text
enabled: true
```

Il controllo client sugli username serve solo a migliorare l'interfaccia. L'autorizzazione reale resta il documento Firestore `admins/<UID>` verificato dalle Security Rules.
