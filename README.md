# European Match Predictor

Web app statica per prevedere le partite delle principali competizioni europee.

## Competizioni selezionabili

Coppe UEFA:

- UEFA Champions League;
- UEFA Europa League;
- UEFA Conference League.

Campionati Big Five:

- Premier League;
- LaLiga;
- Serie A;
- Bundesliga;
- Ligue 1.

I campionati minori non compaiono nel selettore. Le sole partite nazionali dei club UEFA provenienti da altri campionati possono essere conservate come supporto interno alla forma e all'Elo delle coppe.

## Flusso utente

1. scegli una coppa o un campionato dal selettore compatto con logo;
2. seleziona il turno;
3. scegli facoltativamente una squadra da evidenziare;
4. premi **Calcola**;
5. apri una partita per vedere punteggi esatti, probabilità 1X2, xG, Over 2.5, BTTS e confronto degli indicatori principali (tab "Analisi"); tab "Dati extra" per contesto pre-partita, medie recenti di corner/cartellini/possesso (non un input del modello, solo contesto storico), **formazioni probabili** con il modulo effettivamente riportato da ESPN, e tutta la rosa campionata per squadra con minuti attesi e probabilità stimate di tiro/gol/assist/cartellino per QUESTA partita (ancorate al lambda già calcolato dal modello, non medie storiche) insieme allo storico grezzo;
6. da `schedina.html`, indica quante partite vuoi giocare e quanta sicurezza vuoi: il modello cerca la combinazione che paga di più rispettando quella sicurezza.

L'interfaccia è responsive e conserva nel browser competizione preferita, squadra evidenziata, colori e parametri di recenza.

## Dataset

`scripts/update_top5_data.py` aggiorna `data/matches.json` usando fonti pubbliche:

- calendari e risultati delle coppe dall'API pubblica UEFA, con ESPN come fallback;
- calendari e risultati dei Big Five da ESPN;
- statistiche di tiro, corner, cartellini, possesso e **quote di apertura e di chiusura** da Football-Data.co.uk (media di mercato, poi Bet365, poi Pinnacle): 1X2 aperture (`AvgH`) e chiusure (`AvgCH`), miglior prezzo di chiusura (`MaxCH`), Over/Under 2.5 aperture e chiusure, handicap asiatico di chiusura. Fino al 28/08/2026 veniva conservata la sola apertura, documentata per errore come chiusura: vedi `MISTAKES.md` §25;
- arbitro della partita, da Football-Data.co.uk;
- xG Understat quando la pagina lega espone ancora il blob `datesData`; fallback via l'endpoint JSON `getTeamData` (per-squadra, stesso schema dati, nessuna dipendenza extra) quando non lo espone più; fallback finale prudente basato su tiri e tiri in porta.

### Errori arrivati in produzione

`MISTAKES.md` cataloga i venticinque difetti che hanno raggiunto il sito o il dataset pubblicato — non le ipotesi respinte, che sono il funzionamento normale del progetto. Per ciascuno: cosa è successo, quanto è costato, **perché nessun test l'ha visto**, e cosa lo intercetta adesso.

Il pattern che ne esce: ventitre difetti su venticinque stanno **fra** due componenti e non dentro uno, nessuno solleva un'eccezione (producono tutti un numero plausibile), e un valore neutro a valle nasconde il difetto a monte — motivo per cui i contratti girano con i meccanismi spenti *accesi*.

### Identità delle squadre: una squadra, un nome (correzione del 25/08/2026)

Fonti diverse scrivono lo stesso club in modo diverso — ESPN "Atletico Madrid", Football-Data.co.uk
"Ath Madrid", Understat "Atletico Madrid", l'API UEFA "Atl. Madrid". `merge_matches()` deduplica le
partite sulla chiave `(competition_id, date, home_team, away_team)` e `enrich_xg()` aggancia gli xG
sulla stessa chiave: se le grafie divergono, **la chiave non coincide e non succede niente di
visibile**. Nessuna eccezione, nessun test rotto, solo numeri plausibili.

Misure sul dataset del 24/08/2026, prima della correzione:

| difetto | misura |
|---|---|
| coppie di righe duplicate nei Big Five | **210** (25 famiglie di alias) |
| identità di squadra in Bundesliga 2425 | **22** per un campionato da 18 |
| identità di squadra in LaLiga 2425 | **28** per un campionato da 20 |
| righe di LaLiga 2425 | **411** invece di 380 |
| copertura xG `esp.1` / `ger.1` 2526 | **36%** / **23%** contro il 90% della Serie A |

Le tre conseguenze hanno un'unica causa. La stessa partita reale era presente due volte, ciascuna
copia con metà delle statistiche (la riga ESPN con l'xG, la riga Football-Data con tiri e quote). La
storia di un club era divisa fra due identità, ciascuna con Elo, forma e medie calcolate su un
frammento. E lo split attraversava il confine coppe/campionato: **Athletic Bilbao aveva 114 gare
come "Ath Bilbao" e 14 come "Athletic" in LaLiga, e 22 come "Athletic Bilbao" in Europa, con zero
sovrapposizione** — nelle previsioni di coppa era una squadra senza storia. Lo stesso valeva per
Lipsia/Leipzig e Rayo Vallecano/Vallecano.

La copertura xG bassa **non era un problema di Understat**: l'endpoint `getTeamData` risponde
correttamente per tutte e cinque le leghe (verificato dal vivo il 25/08/2026, tutti i titoli
restituiti si normalizzano oggi sul nome canonico). Mancava la chiave di aggancio.

Correzione in tre pezzi:

- `TEAM_ALIASES` in `update_europe_data.py` dichiara la famiglia di alias per club, e
  `_fold_team_name()` fonde da sola le varianti che differiscono solo per accenti o punteggiatura
  ("Alavés"/"Alaves", "St. Pauli"/"St Pauli") — 9 famiglie su 25 non vanno quindi elencate a mano;
- `scripts/repair_dataset_identities.py` applica la stessa canonicalizzazione al dataset già
  generato, rifonde le righe diventate duplicate con la regola di `merge_matches()` e, con
  `--backfill-xg`, riaggancia gli xG mancanti da Understat;
- `fetch_league_matches_via_team_api()` scarta le righe fuori dalla finestra di stagione richiesta.
  Serve contro un fallimento che non assomiglia a un fallimento: `understat.com/team/Parma/2024`
  risponde **200 OK con le partite del Parma FC 2014-15**, un'entità diversa. Righe ben formate, che
  semplicemente non agganciano nulla — 38 partite su 38 senza xG e nessun messaggio di errore. Lo
  slug corretto è `Parma_Calcio_1913`.

Copertura xG dopo la correzione:

| lega | 2324 | 2425 | 2526 |
|---|---|---|---|
| eng.1 | 77% → **100%** | 78% → **100%** | 78% → **100%** |
| esp.1 | 46% → **99.7%** | 35% → **100%** | 36% → **99.7%** |
| fra.1 | 77% → **99.3%** | 76% → **100%** | 85% → **97.4%** |
| ger.1 | 34% → **100%** | 34% → **99.7%** | 23% → **100%** |
| ita.1 | 99% → **99.5%** | 90% → **99.7%** | 90% → **100%** |

Due test fanno da rete, ed entrambi fallivano sul dataset che conteneva i difetti:
`tests/test_team_name_normalization.py` (le 26 famiglie di alias devono collassare su un nome, e i
club distinti **non** devono fondersi) e `tests/test_dataset_identity_contract.py` (nessuna
lega/stagione con più identità che squadre, nessuna squadra oltre il calendario, nessuna coppia di
nomi che differisce solo per grafia, copertura xG sopra il 70% per lega **e** sopra il 50% per
singola squadra). L'ultima soglia non è ridondante: un solo slug sbagliato su venti squadre costa il
10% di copertura e lascia la lega sopra la soglia aggregata — è successo con "Hellas Verona", che
Understat chiama "Verona".

Il dataset contiene:

- `competitions`: le tre coppe UEFA e i cinque campionati, con fixture, turni, paese e logo;
- `matches`: storico usato dal modello, incluse quote/corner/cartellini/possesso/arbitro quando disponibili;
- `team_context`: formazione probabile, disponibilità e fattori neopromosse per squadra, se `scripts/enrich_competitions_players.py` è stato eseguito dopo `update_top5_data.py`. **Non è un input del modello**: dal 27/08/2026 nessun chiamante lo passa a `predictFromMatches` — vedi `prediction-inputs.js`;
- `player_context`: per squadra, tutti i giocatori campionati di recente con minuti, gol, assist, tiri, tiri in porta, cartellini, tassi per-90 (grezzi e con shrinkage di ruolo), probabilità di titolarità e undici probabile con il modulo riportato da ESPN. Tre dettagli non ovvi su come questi dati vengono estratti, ciascuno un bug corretto:
  - **i minuti giocati non esistono** nell'endpoint `summary` di ESPN (la lista `stats` per giocatore contiene presenze, gol, assist, tiri, tiri in porta, falli e cartellini, e nient'altro). Vengono ricostruiti dagli eventi di sostituzione: titolare mai sostituito → 90', titolare uscito al 61' → 61', subentrato al 61' → 29'. Cercarli come campo `minutes` restituiva 0 per ogni giocatore, e da lì ogni tasso per-90 e ogni probabilità mostrata erano esattamente 0;
  - **gli eventi partita hanno due schemi diversi**: lo `scoreboard` usa i flag booleani `yellowCard`/`redCard` con `athletesInvolved`, il `summary` usa `type.text` con `participants`. Vanno letti entrambi, e le fonti vanno unite (non "la prima non vuota": `header.competitions[0].details` contiene solo i gol, `keyEvents` contiene tutto) deduplicando per tipo, minuto e giocatori;
  - **i panchinari hanno ruolo "SUB"**, che è uno stato e non un ruolo. Il ruolo vero si ricava per voto di maggioranza sulle partite in cui il giocatore è sceso in campo, completato dal roster di squadra per chi non è mai stato visto titolare;
- `referee_stats`: tendenze regolarizzate (shrinkage bayesiano) per arbitro. **Non è un input del modello**: è calcolato in-sample e non è ricostruibile in avanti (R13), quindi non lo passa né la pagina né alcun backtest;
- `domestic_leagues`: elenco fisso dei Big Five selezionabili;
- `coverage`, `source_health` e `sources`: indicatori di copertura.

La raccolta dati è volutamente limitata ai Big Five e alle tre coppe UEFA: niente più fetch per campionati minori (~40 leghe di supporto, la maggior parte delle chiamate ESPN per quelle falliva comunque con HTTP 400). Per le coppe UEFA questo significa che i club fuori dai Big Five (es. squadre di Eredivisie, Primeira Liga, Veikkausliiga...) partono con priori Elo meno informati, basandosi solo sulle partite giocate nella coppa stessa e non sul loro storico di campionato domestico — un compromesso deliberato a favore di un dataset più piccolo, veloce da rigenerare e senza rumore nei log.

Restano esclusi dal flusso attivo transfer window e notizie last-minute non presenti nelle fonti sopra; l'arbitro di una partita futura non è disponibile automaticamente da nessuna fonte usata qui (va fornito manualmente se lo conosci in anticipo, vedi sotto).

## Modello 6.0 Shrunk Asymmetry

Il modello usa esclusivamente segnali pre-partita stabili e disponibili in modo omogeneo:

- gol, xG e xGA recenti;
- tiri e tiri in porta;
- forma recente in punti per partita;
- rendimento casa/trasferta;
- Elo aggiornato cronologicamente;
- giorni di riposo;
- baseline specifica della competizione;
- Poisson con correzione Dixon–Coles per i punteggi bassi.

Dalla 5.0 restano quattro correzioni validate con backtest temporale:

- le statistiche generali sono normalizzate contro una baseline neutrale, mentre i soli split casa/trasferta usano le rispettive medie di venue;
- la recenza è pesata in giorni di calendario, non soltanto per numero di partite;
- l'affidabilità cresce con shrinkage regolare e l'Elo decade lievemente dopo inattività prolungata;
- quando sono disponibili xG reali, l'aggiornamento Elo combina risultato e qualità della prestazione, riducendo il rumore dei singoli episodi.

### Calibrazione dei lambda (la novità della 6.0)

`scripts/diagnose_calibration.mjs` ha misurato un difetto sistematico della 5.0: **il modello era
sovra-sicuro**. La curva di affidabilità era più piatta della diagonale su entrambi i lati —
quando dava 74% a una vittoria esterna succedeva il 54% delle volte, quando dava 15% a una
vittoria casalinga succedeva il 23%.

La correzione agisce sui due lambda *prima* di costruire la matrice dei punteggi. In coordinate
logaritmiche rispetto alla baseline di competizione si separano **livello** (quanti gol in
totale) e **asimmetria** (chi è più forte):

```
sH = ln(λcasa / baselineCasa)      sA = ln(λtrasferta / baselineTrasferta)
livello = (sH + sA)/2              asimmetria = (sH − sA)/2
```

L'errore stava nell'asimmetria, non nel livello (il bias su Over 2.5 era già solo −0.5pp):
comprimendola le probabilità 1X2 si avvicinano alla frequenza osservata mentre i gol attesi
restano quelli di prima. Ricalibrare invece le tre probabilità finali (temperature scaling, il
rimedio da manuale) avrebbe lasciato Over 2.5, BTTS e risultati esatti incoerenti con l'1X2
mostrato loro accanto: tutti derivano dalla stessa matrice.

I parametri (`DEFAULT_CALIBRATION` in `model.js`) sono stimati da `scripts/fit_calibration.mjs`
su una finestra di training e validati su una finestra successiva mai usata per la stima. Sono
stabili su tre split diversi. Risultati misurati su 3000 gare:

| | 5.0 | 6.0 |
|---|---|---|
| log loss | 1.0319 | **1.0151** |
| Ranked Probability Score | 0.2168 | **0.2120** |
| accuratezza | 48.9% | **50.5%** |
| errore di calibrazione (casa / trasferta) | 0.068 / 0.065 | **0.024 / 0.028** |
| scarto medio vs mercato de-vigato (1 / X / 2) | −0.7 / −1.5 / +2.2 pp | **+0.4 / −0.5 / +0.1 pp** |

Il divario dal mercato di chiusura si è dimezzato (log loss 1.0401 → 1.0167 contro 0.9985 del
mercato), ma **il mercato resta davanti**: non c'è alcun vantaggio dimostrabile da sfruttare, e
`npm run backtest:market` continua a dirlo esplicitamente.

Due note sul metodo, perché i numeri sopra si possano leggere per quello che sono:

- la funzione obiettivo somma il log loss di 1X2, Over 2.5 e Gol/No gol. Con il solo 1X2 la
  ricerca usava il parametro di livello come variabile libera (il log loss 1X2 è quasi
  insensibile al numero totale di gol) e lo spingeva a gonfiare Over 2.5 di 4.6 punti;
- `levelShrink` resta debolmente identificato (la ricerca lo colloca tra 0.32 e 0.60 secondo lo
  split, con log loss praticamente identico). Il valore in produzione è il centro di
  quell'intervallo, non un ottimo puntuale da prendere alla lettera.

Per i cinque campionati il filtro di training resta limitato esattamente ai Big Five, quindi l'aggiunta delle coppe non modifica i pronostici nazionali. Per le coppe, il modello combina storico UEFA e forma nazionale delle squadre partecipanti, mantenendo una baseline separata per ciascuna competizione quando il campione è sufficiente.

Tutte le partite dello stesso turno condividono il medesimo cutoff precedente alla prima gara, evitando leakage tra anticipi e partite successive.

## Mercati sui singoli giocatori

`estimatePlayerMarkets` in `model.js` proietta, per ogni giocatore di ogni squadra, le
probabilità di segnare, di segnare due volte, di fare gol o assist, di tirare (1+, 2+, in
porta) e di prendere un cartellino **in quella specifica partita**. L'ancoraggio al resto del
modello è il punto: la probabilità di gol passa dal lambda che `predictFromMatches` calcola per
quella squadra in quella partita, quindi un avversario debole alza il lambda e con esso la
probabilità di gol dei suoi attaccanti, in coerenza con l'1X2 mostrato accanto.

Tre scelte statistiche, ognuna con la sua ragione:

1. **Miscela sugli scenari di impiego** (titolare / subentrato / in panchina) invece dei minuti
   attesi. Un giocatore non "gioca metà partita": o parte titolare, o subentra, o resta fuori.
   Usare la media dei tre scenari assegnava a chi parte titolare una volta su due "45 minuti
   certi", che non gli capitano mai.
2. **Binomiale negativa invece di Poisson.** La Poisson assume che il tasso di un giocatore sia
   lo stesso in ogni partita; [`docs/player-probability-study.md`](docs/player-probability-study.md)
   §4.3 aveva già misurato il costo di quell'assunzione (errore di calibrazione ×14 sui tiri,
   ×22 sui 2+ tiri, modello "sistematicamente troppo sicuro nella fascia alta") senza però che
   il codice ne tenesse conto. Ora ne tiene conto.
3. **Shrinkage bayesiano verso il prior di ruolo.** Su tre-quattro partite campionate il tasso
   grezzo di un attaccante che ha segnato una volta in 200 minuti è 0.45 gol/90 — il ritmo del
   capocannoniere d'Europa — e quello di chi non ha ancora segnato è esattamente 0. I tassi
   usati per prevedere sono quelli con shrinkage (`*_per90_shrunk`); i grezzi restano esposti
   e mostrati come storico.

Ogni stima porta con sé un campo `confidence` derivato dai minuti realmente osservati, mostrato
nell'interfaccia come "poco campionato" sotto i 450 minuti e usato dal costruttore della
schedina per preferire le stime più solide.

**Limiti dichiarati**: si assume che il tasso per-90 resti stabile; la probabilità di titolarità
è storica, non una notizia di formazione; non c'è correzione per il rendimento difensivo
dell'avversario contro quel ruolo specifico; "gol o assist" assume indipendenza condizionata
allo scenario di impiego, il che sottostima leggermente la probabilità congiunta.

### Gli input della previsione, e chi li passa

`prediction-inputs.js` è l'**unica** sorgente degli input che raggiungono `predictFromMatches` senza identificare la partita. La pagina (`app.js`) e i backtest costruiscono le loro opzioni come `{ ...modelInputs(...), <identità della partita> }`, così che un input nuovo arrivi a entrambi o a nessuno dei due (R13/R14). Oggi `modelInputs()` dichiara `windowDays` (540) e `halfLifeDays` (120), e nient'altro.

`tests/prediction-input-parity.test.js` fallisce se un chiamante torna a scriversi un input a mano, se i due chiamanti divergono, se i default del contratto smettono di coincidere con quelli di `model.js`, o se a `predictFromMatches` viene aggiunta un'opzione senza decidere da quale lato debba arrivare. È il criterio di accettazione di Q1: la divergenza non deve essere solo corretta, deve diventare impossibile da reintrodurre in silenzio.

L'identità della gara — `homeTeam`, `awayTeam`, `date`, `cutoffDate`, `competitionId`, `season` — resta scritta sul posto perché cambia a ogni chiamata. `season` ne fa parte dal 27/08/2026: prima veniva **dedotta** dai confini delle stagioni presenti nell'array, e la deduzione dava risposte diverse in produzione e in backtest alla prima giornata di una stagione nuova (`payload.matches` contiene solo gare concluse, quindi in produzione la stagione in corso non c'è ancora). Vedi `docs/misure-riferimento.md` §19.

`tests/leakage-truncation.test.js` verifica R13 come invariante eseguibile: prevedere una gara con il dataset intero e con il dataset troncato alla data della previsione deve dare lo stesso risultato bit per bit. Gira con gli iperparametri di stagione **accesi** — ai valori neutri di produzione il difetto di §19 sarebbe invisibile. `scripts/diag_leakage_truncation.mjs` esegue la stessa verifica sul dataset vero.

### Segnali opzionali (di default nessun effetto sulle previsioni esistenti)

Input aggiuntivi, tutti spenti finché non li passi esplicitamente — attivarli non cambia nessuna previsione già calibrata:

- **`teamContext`**: formazione probabile/disponibilità/neopromosse per squadra (da `team_context` nel dataset, se `enrich_competitions_players.py` è stato eseguito). **Non più passato da `app.js`** dal 27/08/2026: misurato appaiato a +0.0002 ± 0.0010 (0.21σ) su `fra.1`, dove tocca il 94% delle gare, e a 0 su `eng.1`, dove non ne tocca nessuna — un perturbatore a valore nullo con una struttura di bias per lega. `scripts/diag_prod_vs_measured.mjs` riproduce la misura.
- **`hyperparameters`**: sovrascrive uno o più dei parametri di `DEFAULT_HYPERPARAMETERS` in `model.js` (rho di Dixon-Coles, esponenti attacco/difesa, divisore/clamp Elo, pesi momentum, soglie di riposo, sconto Elo per neopromosse). Vedi `npm run tune`.
- **`refereeHomeBias`**: scostamento nel tasso di vittorie casalinghe per uno specifico arbitro (da `referee_stats`). Nessuna fonte usata da questa pipeline conosce l'arbitro di una partita futura prima dell'annuncio: va passato a mano per una partita specifica, non è automatico. **Non più cablato da `app.js`** dal 27/08/2026: il guadagno di +0.0050 ± 0.0012 era interamente leakage (+0.0001 ± 0.0010 ricalcolato in avanti) e in produzione era comunque inerte.
### Identità delle squadre

Un club deve avere **un nome solo**, e il contratto lo verifica su `data/matches.json`. Oltre agli split per grafia già chiusi da Task 1, `tests/test_dataset_identity_contract.py` copre ora anche gli split fra coppe e campionato: tre club (Atlético Madrid, Dortmund, PSG) esistevano come due squadre diverse perché l'API UEFA usa grafie proprie (`Atleti`, `B. Dortmund`, `Paris`). Nel caso del PSG era anche una collisione, perché `Paris` in Ligue 1 è il Paris FC.

Il difetto era invisibile a ogni misura domestica — una previsione di campionato filtra via le coppe — e viveva solo nelle previsioni europee. Ricomporlo vale **+0.0145 di log loss in Champions League** (`docs/misure-riferimento.md` §23), il guadagno più grande mai misurato nel progetto.

`Paris` non è risolvibile con un alias globale: la mappa è limitata alla fonte, in `update_uefa_data.UEFA_TEAM_OVERRIDES`.

### Confidenza dichiarata

Ogni previsione porta `confidence`: un'etichetta (Alta/Media/Bassa) e un elenco di motivi in chiaro (`confidence.limits`) — «nessuna gara di questa stagione pesa nel campione», «nessun dato di xG», «squadra senza storia recente in questa competizione». L'interfaccia li mostra sopra il dettaglio, non solo nel tooltip del badge.

È un canale di **sola lettura**: calcolato dopo le probabilità, da quantità già fissate, non entra in nessuna formula che produca una previsione. La distinzione è deliberata — *reagire* alla scarsità di dati (pesare di più la stagione in corso, regredire l'Elo, scontare le neopromosse) è la famiglia respinta cinque volte su cinque, e quei parametri restano a valore neutro. Qui si dichiara e basta.

Validata: `npm run diagnose:confidence` su 8141 gare dà Alta 0.9905, Media 1.0252, Bassa 1.0369 — monotona, con Alta vs non-Alta a **4.23σ**. Non è decorazione: ordina davvero le gare per accuratezza. Vedi `docs/misure-riferimento.md` §22.

- **`sharedDispersion`**: varianza di un fattore di prolificità condiviso fra le due squadre della stessa partita (binomiale negativa bivariata). Alza il pareggio a spese di entrambe le vittorie. Resta **0 per decisione misurata**: respinto con soglia pre-registrata, train e holdout entrambi monotoni verso il peggio. Vedi `docs/misure-riferimento.md` §20.
- **`seasonQualityWeight`**: peso della freschezza di stagione dentro `dataQuality` (vedi sotto). Resta **0 per decisione misurata**, non per dimenticanza.
- **`seasonEloRegression`**: quota di scostamento dalla media di lega che una squadra conserva al cambio di stagione. Resta **1 (nessuna regressione) per decisione misurata**, vedi sotto.
- **`newcomerEloAnchor` / `newcomerEloRetention`**: dove sta l'ancora del prior da neopromossa (0 = il 1500 storico, 1 = la media della lega di destinazione) e quanto Elo una squadra rientrata conserva per ogni stagione di assenza. Default 0 e 1, entrambi neutri.

### Neopromosse: la definizione era sbagliata

`newcomerTeams()` chiamava "nuova" una squadra la cui prima gara nella finestra coincide con la prima
gara nell'**intero dataset**. Il Frosinone era in Serie A nel 2324, quindi è nel dataset, quindi non
è mai stato riconosciuto come neopromosso — qualunque valore avesse `newcomerEloDiscount`. Il gancio
esisteva, era documentato, era testato, e cambiava qualcosa in 87 gare su 768.

`competitionNewcomers()` usa la definizione corretta — "non era in questa competizione nella stagione
precedente" — e distingue chi rientra dopo una stagione, chi dopo più stagioni e chi non si è mai
visto. Il riconoscimento si applica al **confine di stagione** e non solo al cold start: una squadra
rientrata ha già uno stato, con l'Elo di due anni prima, quindi `!states.has(team)` non l'avrebbe
mai intercettata. Gare toccate in Serie A: **da 87/768 a 751/768**.

Il prior giusto è stato **misurato**, non scelto: sulle 14 neopromosse di `2425` nei cinque
campionati il punteggio Elo medio è 0.324, cioè **128 punti Elo sotto il campo**, con tutte e 14 le
squadre sotto la media e le stime per lega comprese in 34 punti dopo lo shrinkage. Il default di
produzione per una squadra al debutto è 1500: questa misura dice che è sbagliato di 128 punti.

Attivarlo dà +0.0011 sul training (IC 95% [0.0003, 0.0019], e +0.0099 ± 0.0029 sulle prime tre
giornate) e +0.0005 sull'holdout `2526`, con IC che però **include lo zero**. Il cancello del brief
chiede significatività fuori campione, quindi **il prior resta spento**; per accenderlo:
`hyperparameters: { newcomerEloDiscount: -128, newcomerEloAnchor: 1 }`.

`newcomerEloRetention` resta a 1: è l'unico dei tre parametri con effetto **negativo e significativo
su entrambe le finestre**, e con Task 2 e Task 3 forma la terza conferma indipendente che scontare la
forza che una squadra si porta dietro peggiora le previsioni.

### Freschezza di stagione: meccanismo costruito, ipotesi respinta

`quality.seasonFreshness` misura quale quota della **massa di peso** delle medie del modello viene
dalla stagione in corso, con la stessa half-life e profondità dei termini che costruiscono metà del
lambda (70 giorni, ultime 16 gare). Non conta le partite: pesa il contributo che hanno davvero nelle
medie. Misurato su 3544 gare dei Big Five:

| fascia | 01-03 | 04-06 | 07-10 | 11-19 | 20+ |
|---|---|---|---|---|---|
| `seasonFreshness` | 0.228 | 0.625 | 0.810 | 0.964 | 1.000 |
| `quality.score` (peso 0) | 0.947 | 0.998 | 0.998 | 1.000 | 1.000 |

La seconda riga è il difetto: alla prima giornata il modello è sicuro quanto alla trentesima, perché
`depth` conta la coda di 40 gare che attraversa l'estate e `xgCoverage` — dopo la correzione della
pipeline — è satura ovunque. Il meccanismo di prudenza (`applyCalibration` interpola `shrink` fra
0.30 e 0.71 su questo score) esiste, è calibrato, e non si accende mai.

**L'ipotesi era che accenderlo aiutasse. I dati dicono di no**, e lo dicono due volte. Stima su
`2324`+`2425` (2779 gare) e validazione sull'holdout `2526` (1792 gare), cinque pesi di griglia,
confronto appaiato:

| peso | train, aggregato | holdout, aggregato | holdout, fascia 01-03 | holdout, fascia 04-06 |
|---|---|---|---|---|
| 0.15 | −0.0001 | −0.0002 | −0.0006 ± 0.0018 | −0.0011 ± 0.0010 |
| 0.30 | −0.0003 | −0.0004 | −0.0018 ± 0.0037 | −0.0025 ± 0.0020 |
| 0.45 | −0.0005 | −0.0007 | −0.0036 ± 0.0055 | −0.0040 ± 0.0030 |
| 0.60 | −0.0008 | −0.0011 | −0.0060 ± 0.0073 | −0.0056 ± 0.0040 |
| 0.75 | −0.0011 | −0.0016 | −0.0090 ± 0.0092 | −0.0075 ± 0.0050 |

Degrado **monotono nel peso**, su entrambe le finestre, e a peggiorare di più sono proprio le fasce
di inizio stagione che la modifica doveva aiutare. Il segmento 07-10 in poi è quasi insensibile,
come atteso da come il termine è costruito.

La lettura che ne segue è più utile del parametro: **il costo di inizio stagione non è
sovra-sicurezza sul rapporto di forza.** Comprimere l'asimmetria significa avvicinare le probabilità
alle frequenze di lega, e farlo di più a settembre peggiora — quindi il segnale di forza che il
modello si porta dietro dalla stagione precedente è *informativo*, non rumore da scontare. Le prime
giornate sono semplicemente più difficili da prevedere, e la calibrazione esistente sta già
trattando quel livello di incertezza in modo adeguato.

Il codice resta, spento e coperto da test (`tests/season-freshness.test.js`): espone
`quality.seasonFreshness` come diagnostica e rende l'ipotesi rimisurabile con un solo numero. Serve
distinguere "non migliora" da "non fa niente", che sono due conclusioni diverse — le asserzioni sul
peso esercitato provano che il meccanismo funziona; la stima dice che l'ipotesi che lo motivava no.

### Elo al confine di stagione: stesso esito, per una via indipendente

`decayInactiveElo()` copriva da sola due fenomeni che non hanno niente in comune: una squadra che
non gioca per calendario, e una squadra che ricomincia con rosa, allenatore e obiettivi nuovi. Con
una pausa estiva di 95 giorni la retention vale `exp(-(95-45)/900) = 0.946`, quindi una squadra a
1700 riapriva a 1689 — il 5.4%, contro il 20-35% verso la media di lega che è la pratica consolidata
nei sistemi Elo calcistici. E regrediva verso `baselineElo` (1500) invece che verso la media di lega
vera, che vale 1520-1570 secondo il campionato.

`regressSeasonBoundaryElo()` separa i due, rileva il confine dal campo `season` (non da "sono passati
N giorni", che confonderebbe la sosta invernale con il cambio stagione) e regredisce verso la media
della lega di **destinazione**, che è il caso della promossa. Va applicata anche in avanti dentro
`stateMetrics()`: alla prima giornata assoluta il dataset non contiene ancora nessuna gara della
stagione nuova, quindi applicarla solo quando una partita entra nello stato l'avrebbe resa inerte
esattamente nel momento in cui serve.

**Anche qui i dati dicono di no.** Stima su `2324`+`2425`, validazione sull'holdout `2526`:

| `k` | holdout aggregato | holdout 01-03 | holdout 04-06 |
|---|---|---|---|
| 0.90 | −0.0005 | −0.0012 ± 0.0008 | −0.0022 ± 0.0007 |
| 0.80 | −0.0009 | −0.0024 ± 0.0015 | −0.0043 ± 0.0013 |
| 0.70 | −0.0014 | −0.0037 ± 0.0022 | −0.0063 ± 0.0020 |
| 0.60 | −0.0019 | −0.0050 ± 0.0029 | −0.0084 ± 0.0026 |
| 0.50 | −0.0025 | −0.0064 ± 0.0036 | −0.0104 ± 0.0031 |

Il criterio chiedeva un guadagno di almeno due errori standard sul segmento 01-06; il segmento 04-06
ne **perde circa tre** a `k = 0.70`. Il meccanismo è attivo su 1792 gare su 1792, quindi non è
inerzia: è proprio l'effetto a essere del segno sbagliato.

Due meccanismi indipendenti che attaccano la stessa ipotesi — comprimere l'asimmetria in blocco,
scontare la forza ereditata — e la peggiorano entrambi in modo monotono. Presi insieme dicono che
**il rapporto di forza che il modello eredita dalla stagione precedente è informativo**, e che il
costo delle prime giornate non è sovra-sicurezza. Una lettura possibile, da verificare: gli esponenti
di attacco e difesa sommano a 1.00 e i loro termini portano anch'essi il livello dell'anno prima a
piena forza (alla 5ª giornata il 41% del segnale viene ancora da lì), quindi scontare il solo Elo non
riduce il differenziale di forza — lo rende incoerente.

### Esito della coda 6.0 -> 6.1, in una tabella

> Sintesi corrente in **`BRIEF-v2.md`**; tutti i numeri, con la data del dataset accanto, in
> **`docs/misure-riferimento.md`**. Il backtest di riferimento è ora `ita.1` **0.9886 / 0.527** e la
> distanza dal mercato **+0.0214 ± 0.0028** (appaiata, 3657 gare con quote).


Ogni parametro nuovo è **neutro di default** e coperto da un test di neutralità bit per bit: il
modello spedito produce previsioni identiche a prima della coda. Le misure sono confronti appaiati
(R3), stimati su `2324`+`2425` e validati sull'holdout `2526` mai usato per stimare (R7). Dettaglio
completo in `docs/misure-riferimento.md`.

| # | intervento | esito | evidenza |
|---|---|---|---|
| 1 | copertura xG | **risolto** | `esp.1` 36→99.7%, `ger.1` 23→100%; e come effetto collaterale tiri/corner/cartellini 64→100%, quote 61→99% |
| 2 | `dataQuality` stagionale | respinto | degrado monotono su due finestre, peggiore proprio sulle giornate 1-6 |
| 3 | regressione Elo a inizio stagione | respinto | holdout −0.0063 ± 0.0020 sul segmento 04-06 |
| 4 | neopromosse | **bug corretto**, prior spento | gare toccate 87→751; prior misurato −128 Elo; +0.0011 train, +0.0005 holdout (IC include lo zero) |
| 5 | vantaggio campo per lega/squadra | chiuso senza modifiche | trend inesistente (2 leghe su 5, p=81%); residuo per lega χ²=5.18 su 5; residuo per squadra al netto del venue **0.14 sigma** |
| 6 | impegno europeo e congestione | neutro | direzione giusta (−4.5pp dopo una trasferta UEFA) ma +0.0001 nel log loss |
| 7 | forma ortogonale all'Elo | respinto | collinearità 0.743→0.267 come richiesto, ma holdout −0.0011 e −0.0025 |
| 8 | sovra-rendimento sugli xG | chiuso | segno che si inverte fra train e holdout |
| 9 | peso dei rossi | **raccomandato** | +0.0009 train, +0.0018 holdout, tutti e cinque i segmenti positivi fuori campione |
| 13 | `lineup_strength` bidirezionale | **corretto, poi spento** | da 0 squadre sotto 1 su 95 a 22 sotto / 24 sopra, mediana 1.0; misurato dopo: +0.0002 ± 0.0010, e mai visto da alcun backtest |
| 14 | interazione di stile | implementata, non stimata | un solo parametro, neutro |

Il risultato che lega 2, 3, 7 e il sotto-caso "solo ritenzione" di 4: **quattro meccanismi
indipendenti che riducono il peso della forza che una squadra si porta dietro peggiorano tutti le
previsioni**, in modo monotono nell'intensità. La diagnosi meccanica del brief era corretta in ogni
caso — il modello davvero non sa che la stagione è cambiata, l'Elo davvero regredisce del 5.4%
invece che del 20-35%, la forma davvero è collineare al 74% con l'Elo — ma l'inferenza che
correggerli avrebbe migliorato le previsioni è falsa su questi dati. Il segnale che sembrava
ridondante non lo è: è la stessa quantità misurata con rumore indipendente, e mediarla è ciò che un
modello dovrebbe fare.

## Avvio locale

Dalla cartella che contiene `index.html` (cioè questa, non quella superiore):

```bash
npm start
```

Aprire `http://localhost:8000`. Per cambiare porta: `npm start -- --port 8080`.

Il server è `scripts/serve.mjs`, poche righe sulla sola libreria standard di Node: nessuna
dipendenza da installare e **stesso identico comando su Windows, WSL, Linux e macOS**. Questo
non è pignoleria: il nome dell'eseguibile Python cambia da sistema a sistema, e il comando
`python -m http.server` suggerito da mezza internet funziona su una piattaforma e fallisce
sull'altra senza che ci sia nulla di rotto nel progetto.

<details>
<summary>Alternativa con Python, e perché il nome del comando cambia</summary>

| | comando che funziona | comando che fallisce |
|---|---|---|
| **Windows** (installer python.org) | `python -m http.server 8000`<br>`py -m http.server 8000` | `python3` — esiste solo come segnaposto del Microsoft Store: stampa *"Python non è stato trovato…"* e non avvia niente |
| **WSL, Linux, macOS** | `python3 -m http.server 8000` | `python` — non installato, `command not found` |

In entrambi i casi il messaggio è breve e il terminale torna subito al prompt: sembra che "non
succeda nulla", ma è il comando a non essere mai partito, non il server ad avere un problema.

</details>

### Se non si connette o la pagina resta bianca

1. **Cartella sbagliata.** Il server pubblica la cartella da cui parte: lanciato un livello più
   su mostra l'elenco dei file invece dell'app. Verificare prima con `dir index.html` (Windows)
   o `ls index.html` (Linux/WSL): se risponde che il file non esiste, la cartella è quella
   sbagliata. `npm start` è immune al problema — serve sempre la cartella del progetto,
   qualunque sia quella corrente.
2. **File aperto con doppio clic.** `index.html` aperto direttamente dal disco resta bianco: la
   pagina usa moduli ES e `fetch` sul dataset, entrambi bloccati dal browser sul protocollo
   `file://`. Va aperto tramite `http://localhost:8000`.
3. **Server in WSL, browser su Windows.** Di norma WSL2 inoltra `localhost`; quando non lo fa
   serve l'indirizzo della VM, che si ottiene con `hostname -I` (per esempio
   `http://172.29.46.201:8000`).
4. **Porta occupata.** `npm start` lo dice esplicitamente e suggerisce la porta successiva,
   invece di uscire in silenzio.

Per capire se il problema è il server o il browser, senza passare dal browser:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/index.html   # atteso: 200
```

Se risponde `200` ma la pagina è bianca, il server è a posto: aprire la console del browser
(F12) e leggere l'errore lì.

## Test e backtest

```bash
node scripts/python.mjs -m py_compile scripts/update_europe_data.py scripts/update_uefa_data.py scripts/update_top5_data.py scripts/understat_team_api.py scripts/enrich_competitions_players.py
npm run test:py
npm test
npm run check
npm run backtest
npm run backtest:market
npm run diagnose
npm run fit:calibration
npm run tune
```

I test verificano catalogo Big Five + UEFA, esclusione dei campionati minori, cutoff comune, normalizzazione delle probabilità, invariabilità dei pronostici Big Five dopo l'aggiunta dei dati europei, le regressioni di calibrazione venue-neutral/xG-Elo, `teamContext` (retrocompatibilità, direzione degli effetti, clamp), gli iperparametri (deep-merge, cold-start neopromosse, bias arbitro), il livello di calibrazione dei lambda, la parità degli input fra produzione e misura, l'invarianza per troncamento (R13), il fattore di dispersione condiviso, la confidenza dichiarata (invarianza delle previsioni, monotonia, potere predittivo sui dati veri), i mercati sui giocatori e il costruttore della schedina.

`tests/player-context-contract.test.js` è di natura diversa dagli altri: verifica il contratto tra la pipeline Python e il codice JavaScript **sul dataset vero**, non su fixture scritte a mano. È il test che sarebbe servito prima — il bug che azzerava ogni probabilità di ogni giocatore (ESPN non espone i minuti giocati, la pipeline li leggeva come 0) non ha rotto nessun test, perché tutte le fixture avevano il campo `minutes` popolato. Un dato mancante in produzione non solleva un'eccezione: produce silenziosamente 0% per tutti, e nell'interfaccia sembra una previsione. Il test salta senza fallire se `data/matches.json` non è presente.

`npm run diagnose` scompone la calibrazione (bias sui lambda, calibrazione marginale 1/X/2, curva di affidabilità per fascia) invece di riassumerla in un numero solo: un modello può avere log loss accettabile e comunque sbagliare sistematicamente su un singolo esito, e il log loss aggregato lo nasconde.

`npm run fit:calibration` ristima i parametri di `DEFAULT_CALIBRATION` su una finestra di training e li valida su una successiva. Mette in cache i lambda grezzi, così la ricerca costa millisecondi invece di minuti per valutazione.

Il backtest usa soltanto informazioni disponibili prima di ogni gara e riporta log loss, Brier multiclass, Ranked Probability Score e accuracy. È possibile limitare l'analisi, per esempio:

```bash
npm run backtest -- --competition ita.1 --since 2025-08-01 --max 500
```

`npm run backtest:market` confronta le stesse previsioni con le quote di chiusura de-vigate: è l'unico modo per sapere se il modello ha un vantaggio reale sul mercato, non solo un log loss basso preso da solo. Dichiara nel risultato (`marketLine`) contro quale linea ha misurato, e ripiega sull'apertura solo per i dataset generati prima dell'estensione di `parse_csv`.

`npm run diagnose:market` separa le due dimensioni che la matrice dei punteggi produce — **asimmetria** (chi vince, misurata dall'1X2) e **livello** (quanti gol, misurato dall'Over/Under 2.5) — e misura il divario dal mercato su ciascuna, più il movimento apertura → chiusura. Quest'ultimo è la sola metrica che si traduce in denaro: se il disaccordo del modello con l'apertura non predice dove va la linea, quel disaccordo è imprecisione, non valore. Risultati in `docs/misure-riferimento.md` §27.

`npm run tune` cerca, per coordinate descent, una combinazione di iperparametri che migliori il backtest rispetto ai default. **Rischio di overfitting reale** con 16 dimensioni cercate su una sola finestra: valida sempre il risultato su un periodo successivo e non usato per il tuning prima di portarlo in produzione.

## Aggiornamento e deploy

Per rigenerare `data/matches.json` in locale (utile per verificare una correzione prima di spingerla su GitHub):

```bash
node scripts/python.mjs -m pip install -r requirements.txt
node scripts/python.mjs scripts/update_top5_data.py --history-seasons 4
node scripts/python.mjs scripts/enrich_competitions_players.py
```

Sovrascrive `data/matches.json` nella cartella corrente — nessun parametro `--target-season` necessario: viene calcolato da solo dalla data odierna (vedi `resolve_target_season`). Passa `--target-season 2728` solo per forzare una stagione diversa da quella corrente.

- `.github/workflows/update-data.yml` aggiorna il dataset quattro volte al giorno, poi arricchisce `team_context` con `enrich_competitions_players.py`; installa `requirements.txt` (solo `requests`, usata per lo scraping Understat con sessione/cookie persistenti — senza, l'endpoint AJAX di Understat risponde vuoto);
- `.github/workflows/validate-pr.yml` valida JavaScript, test e costruzione del dataset (smoke build con `--skip-understat`);
- `.github/workflows/pages.yml` pubblica su GitHub Pages **il dataset presente nel repository**, quello che il workflow precedente ha costruito, arricchito e validato. Non lo ricostruisce: farlo significava servire un dataset senza xG reali e senza `player_context` (vedi `MISTAKES.md` §18), e il controllo pre-deploy verifica ora esattamente quei campi.

## Schedina

`schedina.html` genera, su richiesta esplicita (pulsante "Genera schedina", nessuna chiamata
automatica), una schedina a partire da **quante partite** si vogliono giocare e **quanta
sicurezza** si vuole. Non serve una chiave API: senza, la schedina si costruisce sulle quote
eque del modello.

### Dieci schedine, non una

Il pulsante genera **le dieci schedine migliori** dello stesso turno, non dieci varianti della
prima né dieci combinazioni prese a caso. L'enumerazione è esatta (procedura di Lawler: trovata
la migliore, lo spazio delle soluzioni si partiziona in blocchi disgiunti e ognuno si risolve con
lo stesso ottimizzatore), quindi la k-esima è davvero la k-esima migliore.

Con un vincolo aggiuntivo che serve a renderle dieci *alternative*: ognuna deve avere **almeno
la metà delle partite diversa da ogni altra** — due su quattro selezioni, tre su sei. Il vincolo
è sulle partite e non sui mercati di proposito: due schedine sulle stesse quattro gare con esiti
diversi non sono due alternative, perché se quel turno va male vanno male entrambe.

Senza quel vincolo le prime dieci soluzioni in ordine di punteggio sono quasi sempre la stessa
schedina con una gamba cambiata — formalmente corrette, praticamente dieci copie.

Quante ne escano dipende da quante partite ha il turno: con cinque gare giocabili non esistono
dieci combinazioni da quattro che condividano al più due partite l'una con l'altra. In quel caso
se ne consegnano meno e **lo si dichiara**, invece di completare la serie con schedine che violano
il vincolo: una schedina che lo viola non è una schedina in più, è una copia mascherata.

Un effetto che si nota subito: le dieci hanno quote quasi identiche (su un turno di Serie A,
4.98–4.99 a fronte del 20% richiesto). Non è un difetto, è la forma del problema: l'ottimo è
piatto, e molte combinazioni diverse pagano lo stesso restando dentro la stessa sicurezza.

**Le dieci condividono le partite, quindi condividono gli esiti.** Giocarle tutte non è
diversificare: è la stessa scommessa moltiplicata, con la stessa correlazione dentro. L'interfaccia
lo dice sopra l'elenco.

### Quota minima per selezione

Il vincolo di sicurezza spinge verso selezioni quasi certe — un 1X al 92% paga 1.08 — che gonfiano
la probabilità combinata e non pagano nulla. L'obiettivo da solo non le esclude, perché è il
*vincolo* a metterle dentro. Il campo «Quota minima per selezione» (default **1.20**) le tiene
fuori.

La gerarchia fra le due richieste è esplicita: la sicurezza è ciò che si chiede, la quota minima è
una preferenza su come ottenerla. Se sono incompatibili — «sicurezza massima» vuole selezioni al
72%, che pagano al più 1.39 — **cede la quota minima**, e il rilassamento viene riportato con il
valore a cui è sceso.

### Storico e verifica a posteriori

`storico.html` conserva le serie generate e ne calcola l'esito dai risultati veri appena le
partite sono state giocate: ogni selezione viene risolta dal punteggio finale (`settleMarket`),
una multipla è persa appena una gamba lo è, e resta «in corso» finché una partita non è finita.
I mercati sui giocatori restano **«non verificabili»**: il dataset non conserva gli eventi della
singola partita, e contarli come persi falserebbe ogni statistica verso il basso.

Da lì esce la sola cosa che quei dati possano dire: la **calibrazione**. Se il modello dichiara il
20% e su cinquanta schedine ne vincono nove, la probabilità mostrata accanto alla quota è onesta;
se ne vincono due, è decorativa.

**Non serve ad addestrare il modello, e non lo fa.** Una schedina è una funzione dei risultati
delle partite, e quei risultati sono già — tutti — i dati su cui il modello è costruito: sapere
che una combinazione di quattro esiti è andata male non aggiunge nulla ai quattro risultati, che
il modello ha già. A dieci schedine a settimana servirebbero comunque anni prima che le
percentuali osservate distinguano qualcosa dal rumore (§27.2 e il conto in `docs/`). È la stessa
distinzione che il progetto applica a `confidence`: si dichiara e si verifica, non si retroagisce.

### Cosa ottimizza, e perché

```
massimizza   Σ ln(quota)  +  0.25 · Σ ln(affidabilità)
con vincolo  Σ ln(probabilità) ≥ ln(sicurezza richiesta)
             esattamente N selezioni, al più una per partita
```

cioè *il massimo che si può vincere restando dentro la sicurezza chiesta*. La sicurezza è la
probabilità che la schedina **intera** vinca, non quella della singola partita, ed entra come
vincolo: chiedere sicurezza massima costringe verso selezioni quasi certe e quindi una quota
bassa, chiedere sicurezza bassa lascia spazio a selezioni più remunerative. Su un turno di
Serie A, con 5 partite: massima → quota 2.00 al 50%, alta → 2.86 al 35%, media → 5.00 al 20%,
bassa → 9.99 al 10%.

L'obiettivo **non** contiene `ln(probabilità)`, e questo è il punto delicato: sembrerebbe
naturale premiare le selezioni più probabili, ma con le quote eque del modello
(quota = 1/probabilità) i due termini si annullano esattamente, il punteggio diventa
insensibile alla sicurezza richiesta, e la funzione restituirebbe la stessa identica schedina
per "sicurezza massima" e per "sicurezza bassa". La probabilità sta nel vincolo, il guadagno
nell'obiettivo. Con quote di mercato reali lo stesso obiettivo diventa automaticamente una
ricerca di valore: a parità di probabilità richiesta, la quota più alta è quella in cui il
banco paga più di quanto il modello ritenga corretto.

Il termine sull'affidabilità distingue selezioni altrimenti equivalenti: fra due partite di
campionato è quasi identico e sparisce, mentre penalizza i mercati su giocatori con pochi
minuti campionati — dove pesa quanto una differenza di quota da 1.10 a 1.50.

La ricerca è **esatta**, non greedy, ed è formulata come uno zaino: il "costo" di una selezione
è quanta probabilità toglie alla schedina (−ln p), la sicurezza richiesta è la capacità, e una
programmazione dinamica su (partite esaminate, selezioni usate, costo accumulato) trova
l'ottimo in pochi millisecondi anche con dieci selezioni e quaranta candidati per partita.

La prima stesura usava invece una ricerca in profondità con limiti superiori ammissibili su
punteggio e probabilità residui. Era altrettanto esatta ma impraticabile — 91 secondi per una
schedina da 8 partite con i mercati sui giocatori attivi — e il motivo è strutturale, non un
difetto dei limiti scelti: con le quote eque `ln(quota) = −ln(probabilità)`, quindi obiettivo e
vincolo consumano la stessa risorsa e qualunque limite calcolato separatamente sui due è
inevitabilmente lasco. Trattare la probabilità come capacità elimina il problema alla radice.

Un dettaglio che sembra minore e non lo è: il numero di candidati per partita va limitato, ma
**tenere le N selezioni più probabili scarta proprio quelle che pagano di più**, cioè quelle che
l'obiettivo cerca — chiedendo sicurezza bassa si otteneva comunque il 29% invece del 10%. Il
campione tenuto è quindi distribuito su tutto l'intervallo di probabilità, estremi inclusi.

### Mercati disponibili

Tutti derivati dalla **stessa matrice dei punteggi** che produce l'1X2 (`deriveMarkets` in
`model.js`), quindi non possono contraddirsi tra loro: 1X2, doppie chance (1X, 12, X2),
Over/Under 0.5–3.5, Gol/No gol, squadra segna. Opzionalmente i mercati sui giocatori
(marcatore, gol o assist, almeno 1 tiro, almeno 2 tiri, tiro in porta).

Due selezioni della stessa partita non vengono mai combinate (`fixtureIndex` condiviso, il
costruttore ne sceglie al più una): moltiplicare come indipendenti due probabilità correlate —
un attaccante segna più facilmente se la sua squadra vince nettamente — sovrastimerebbe la
schedina. Vale anche tra due giocatori della stessa partita.

### Quote reali (facoltative)

Le quote in tempo reale vengono richieste a [the-odds-api.com](https://the-odds-api.com/)
(piano gratuito: 500 richieste/mese, nessuna carta) tramite una chiave personale, inserita e
conservata solo nel browser (`localStorage`, mai nel repository). Il campionato si individua
cercando nel loro catalogo lo `sport_key` documentato (`LEAGUE_SPORT_KEYS`); se quella chiave non
c'è più si ripiega sulla ricerca per parola chiave, e se nemmeno quella è univoca la pagina
chiede una scelta manuale invece di indovinare. La ricerca testuale da sola non bastava: per la
Bundesliga corrisponde anche quella austriaca, e il campionato tedesco non veniva mai risolto
(`MISTAKES.md` §19).

Le squadre si abbinano risolvendo il turno intero (`assignEventsToFixtures`), non una partita
alla volta: ogni evento va a una sola partita e i nomi si confrontano per token, perché con il
contenimento di sottostringa `Paris` — che in Ligue 1 è il Paris FC — si abbinava a `Paris Saint
Germain` (`MISTAKES.md` §20). Un
errore di rete sulle quote non impedisce la generazione: si ricade sulle quote eque e lo si
dichiara.

Ogni selezione che un bookmaker prezza prende un prezzo di mercato. Da dove, e a che costo:

| selezione | mercato API | endpoint | costo |
|---|---|---|---|
| 1, X, 2 | `h2h` | lega | 1 richiesta per turno |
| 1X, 12, X2 | derivate da `h2h`: `1/(1/oA + 1/oB)` | — | zero |
| Over/Under 2.5 | `totals` | lega | 1 richiesta per turno |
| Over/Under 0.5, 1.5, 3.5 | `alternate_totals` | evento | 1 × regioni × partita |
| Gol / No gol | `btts` | evento | 1 × regioni × partita |
| Casa/Trasferta segna | `team_totals` sopra 0.5 | evento | 1 × regioni × partita |
| marcatore | `player_goal_scorer_anytime` | evento | 1 × regioni × partita |
| almeno 1 / 2 tiri | `player_shots`, linee 0.5 e 1.5 | evento | 1 × regioni × partita |
| tiro in porta | `player_shots_on_target` | evento | 1 × regioni × partita |
| gol o assist | nessuno | — | resta quota equa |

Le doppie chance si derivano invece di chiederle perché la derivazione è **esatta** — due esiti
che si escludono hanno probabilità implicita pari alla somma delle implicite — e perché il
margine del banco contenuto nelle due quote resta dentro, che è ciò che le rende confrontabili
con le altre. «Gol o assist» non ha un mercato corrispondente: combinarne due assumendone
l'indipendenza sarebbe la stessa approssimazione che `estimatePlayerMarkets` dichiara come propria
debolezza, e verrebbe mostrata come prezzo di mercato.

I mercati non *featured* (tutto ciò che sta sulla riga «evento») esistono **solo** sull'endpoint
per singolo evento: chiederli a quello di lega fa fallire l'intera richiesta con `INVALID_MARKET`
e lascia la schedina senza nessuna quota reale, comprese le 1X2 (`MISTAKES.md` §22). Si fa
perciò una sola chiamata per partita con tutti i mercati non-featured che servono al turno.
Non è completezza per completezza: la ricerca massimizza `Σ ln(quota)`, e una quota equa
(`ln(quota) = −ln(p)` esattamente) è strutturalmente più alta di una quota di mercato, che
contiene il margine del banco. Mescolarle spingeva la schedina verso i mercati privi di prezzo
reale e mostrava una quota combinata non ottenibile (`MISTAKES.md` §21). Le linee che il
bookmaker non espone non vengono estrapolate: restano quota equa, etichettata "stima".

**the-odds-api conta una richiesta per ogni combinazione mercato × regione**, e per l'endpoint
per evento anche × partita. Nulla viene chiesto «per completezza»: i mercati richiesti sono solo
quelli dei gruppi accesi nel form. Su un turno da 10 partite, con le due regioni interrogate
(`eu,us`, perché la copertura player-prop delle Big Five sta sui libri USA):

| gruppi accesi | richieste |
|---|---|
| 1X2, doppia chance | 1 |
| + Over/Under e Gol/No gol | 1 + 1 + 2×2×10 = **42** |
| + squadra segna | + 2×10 = **62** |
| + mercati sui giocatori | + 3×2×10 = **122** |

Sul piano gratuito da 500 al mese sono ~4 generazioni complete, contro 500 con le sole 1X2 e
doppie chance. Il preventivo compare nel resoconto della schedina insieme alle richieste rimaste,
lette dagli header `x-requests-used` e `x-requests-remaining` di ogni risposta: senza, l'unico
modo di sapere di aver finito la quota è vedere fallire una generazione con HTTP 429.

### Cache locale delle quote

Le risposte dell'API vengono conservate nel browser (`localStorage`) e riusate per **tre ore**,
con chiave `campionato + turno + mercati richiesti`: rigenerare la schedina dello stesso turno —
cosa che si fa continuamente, cambiando numero di partite o sicurezza — non ricompra le stesse
quote. Su un turno con i mercati per evento attivi la differenza è fra ~120 richieste e zero.

La scadenza non è un dettaglio implementativo: **una quota vecchia non è una quota mancante, è un
prezzo sbagliato** che la schedina userebbe come vero. Per questo ogni voce porta il momento in
cui è stata scaricata, scade da sola, e il resoconto dichiara sempre quante risposte vengono dalla
cache e quanto è vecchia la più vecchia. La casella «Riscarica le quote ignorando la cache» forza
il download quando il turno si avvicina. Cambiare i mercati selezionati è una richiesta diversa e
non riusa la precedente; l'elenco eventi non viene messo in cache perché è un endpoint gratuito.

Le quote sui giocatori richiedono `regions=us` (la copertura player-prop per le Big Five è lì,
non su `eu`) e una chiamata per evento. Quando non disponibili si usa la quota equa del
modello, etichettata "stima" nell'interfaccia invece di spacciarla per una quota di mercato.

`slip-builder.js` contiene l'ottimizzatore puro (testato in `tests/slip-builder.test.js`),
`schedina.js` la costruzione dei candidati e l'accesso alle quote. Il fetch delle quote live
non è verificabile da questo ambiente di sviluppo (nessun accesso di rete a domini di quote):
verificato solo con una risposta simulata che replica lo schema documentato dell'API.

Nota matematica mostrata nell'interfaccia: ogni selezione aggiuntiva in una schedina multipla
moltiplica il margine del bookmaker oltre che le quote, rendendola la struttura di scommessa
meno favorevole al giocatore anche quando ogni singola quota è equa. La probabilità mostrata è
la stima del modello: "sicurezza alta" significa che secondo il modello la schedina vince circa
una volta su tre, non che vincerà.

## Limiti

Le previsioni sono probabilistiche e non includono notizie dell'ultimo minuto, formazioni ufficiali confermate, infortuni non curati manualmente, meteo o informazioni tattiche non presenti nelle fonti pubbliche. Gli slug Understat usati dal fallback `getTeamData` sono dedotti dalla convenzione nota del sito: controllare i log al primo run reale (segnalano esplicitamente le squadre con 0 partite risolte). Il progetto non costituisce una promessa di rendimento economico; le quote di chiusura sono tra gli stimatori più efficienti disponibili, batterle in modo sistematico e statisticamente significativo è difficile per costruzione.

## Licenza e fonti

Codice MIT. I dati restano soggetti alle condizioni delle fonti utilizzate: UEFA public match API, ESPN public scoreboards, Football-Data.co.uk e Understat.
