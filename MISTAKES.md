# Errori arrivati in produzione

Catalogo dei difetti che hanno raggiunto il sito o il dataset pubblicato, non delle ipotesi
respinte. Un'ipotesi misurata e scartata è il funzionamento normale del progetto; un difetto che
gira in produzione per settimane senza che nulla se ne accorga è un'altra cosa, e questo file
esiste per rendere visibile il **pattern**, non i singoli casi.

Ogni voce dice cosa è successo, quanto è costato, **perché nessun test l'ha visto**, e cosa lo
intercetta adesso. L'ultima colonna è la sola che conta per il futuro.

Riferimenti puntuali in `docs/misure-riferimento.md`.

---

## Il quadro d'insieme

Trentadue difetti, e si distribuiscono in modo molto disuguale:

| categoria | quanti | impatto misurato sulle previsioni |
|---|---|---|
| Identità dei dati (nomi, alias, join) | 8 | il più grande mai misurato: **+0.0145** in Champions |
| Produzione ≠ misura | 6 | nullo o non misurabile, ma invalidava *ogni* misura |
| Campi calcolati male | 7 | da nullo a "azzerava un'intera funzione" o "ribaltava il calendario" |
| Test e integrazione continua | 1 | nessuno sulle previsioni: bloccava il deploy |
| Fonti dati non raggiungibili | 1 | nessuno sulle previsioni: azzerava ogni misura di mercato |
| Interfaccia e flusso | 9 | funzione principale inutilizzabile, generata e invisibile, o salvata dove non resta |

Tre osservazioni che il catalogo rende difficili da ignorare:

1. **Nessuno di questi difetti solleva un'eccezione.** Producono tutti un numero plausibile. È la
   ragione per cui sono sopravvissuti: il codice non si rompe, risponde male.
2. **Il posto dove i difetti si nascondono è il confine fra due cose** — fra due fonti, fra coppe
   e campionato, fra produzione e backtest, fra due funzioni che formattano lo stesso dizionario.
   Nessuno dei sedici sta *dentro* un componente.
3. **Correggere i dati ha pagato ogni volta; aggiungere parametri mai.** Dieci meccanismi provati
   in tre sessioni, dieci respinti. Cinque correzioni di identità, tutte migliorative.

---

## 1. Il modello in produzione non era il modello misurato

**Cosa.** `app.js` passava a `predictFromMatches` due input che nessuno script di misura passava:
`teamContext` (formazione probabile, disponibilità) e `refereeStats` (bias arbitro). Ogni numero
di log loss prodotto in due sessioni descriveva quindi un modello diverso da quello sul sito.

**Costo.** Il fattore toccava fino al 94% delle gare francesi e nessuna gara inglese, e valeva
+0.0002 ± 0.0010 — rumore con una struttura di bias per lega. Il danno non è il log loss: è che
**due sessioni di misure descrivevano un altro modello**.

**Perché nessuno l'ha visto.** I due chiamanti costruivano le opzioni ciascuno per conto proprio.
Nessun test confrontava le due liste, e non c'era ragione perché qualcuno pensasse a farlo.

**Cosa lo intercetta ora.** `prediction-inputs.js` è l'unica sorgente degli input non identitari;
tutti e cinque i chiamanti scrivono `{ ...modelInputs(), <identità della partita> }`.
`tests/prediction-input-parity.test.js` analizza il **sorgente** dei chiamanti e fallisce in otto
casi, incluso «a `predictFromMatches` è stata aggiunta un'opzione senza decidere da quale lato
debba arrivare» — che obbliga a scegliere invece di arrivarci per omissione.

→ §18

---

## 2. La stagione veniva dedotta, e le due parti deducevano diverso

**Cosa.** `resolveCurrentSeason()` ricavava la stagione dai confini delle stagioni presenti
nell'array. Un commento difendeva la scelta dicendo che l'array «si ferma al cutoff e la data
della previsione cade sempre dopo l'ultima gara che contiene»: vero in backtest, **falso in
produzione**, dove `payload.matches` contiene solo gare concluse e quindi si ferma a oggi. Alla
prima giornata di una stagione nuova il backtest risolveva la stagione N, la produzione ripiegava
sulla precedente.

**Costo.** Zero oggi, perché i tre consumatori di `currentSeason` sono a valore neutro per
decisione misurata. Ma **armato**: accendendo `seasonQualityWeight` il difetto vale 3.2 punti
percentuali su una probabilità 1X2 — e quel parametro è esattamente la strada che il progetto
indica come valore residuo.

**Perché nessuno l'ha visto.** Un test ai valori di default dà verde: i consumatori neutri rendono
invisibile qualunque difetto a monte. Il primo audit, fatto ai default, aveva concluso "nessuna
divergenza".

**Cosa lo intercetta ora.** `season` è diventata identità della gara, passata e non dedotta.
`tests/leakage-truncation.test.js` verifica l'invarianza per troncamento **con gli iperparametri
di stagione accesi**, proprio perché ai default non si vedrebbe.

→ §19

---

## 3. Tre club esistevano come due squadre diverse

**Cosa.** L'API UEFA usa grafie proprie mai dichiarate negli alias:

| club | nei campionati | nelle coppe |
|---|---|---|
| Atlético Madrid | `Atletico Madrid` — 116 gare | `Atleti` — 36 |
| Borussia Dortmund | `Dortmund` — 102 gare | `B. Dortmund` — 37 |
| Paris Saint-Germain | `PSG` — 103 gare | `Paris` — 46 |

Il terzo era anche una **collisione**: `Paris` conteneva le gare europee del PSG *più* quelle di
Ligue 1 del Paris FC, club diverso. Nelle previsioni europee il PSG era una chimera di due
squadre, mentre il PSG vero non aveva storia europea.

**Costo.** Ricomporli vale **+0.0145 di log loss in Champions League** su 812 gare. È il guadagno
più grande mai misurato nel progetto: il divario totale dal mercato è +0.0214, e nessuno dei dieci
meccanismi provati ha mai superato +0.002.

**Perché nessuno l'ha visto.** Una previsione domestica filtra via le coppe, quindi le tre
identità domestiche erano intatte e complete: **il difetto viveva solo nelle previsioni europee**,
e quasi tutte le misure di tre sessioni sono domestiche. I contratti di identità di Task 1
contano le identità *dentro una lega e per stagione*, e un nome che compare solo nelle coppe non
gonfia nessun conteggio.

**Cosa lo intercetta ora.** Tre controlli in `tests/test_dataset_identity_contract.py`. Con un
limite dichiarato: il rilevatore generale prende `B. Dortmund` ma **non** `Atleti`, perché "atleti"
non è contenuto in "atletico madrid". Quel caso è protetto solo dal test di punto fisso, che vale
contro le regressioni e non come scoperta.

→ §23

---

## 4. La schedina chiedeva le quote di partite già giocate

**Cosa.** `matchdays.js` calcolava `firstUpcoming` ma non lo **restituiva**. `schedina.js` lo legge
come `calendar.firstUpcoming`, quindi valeva `undefined` e il fallback cadeva su `matchdays[0]`:
il primo turno della stagione. Un'API di quote espone solo eventi futuri.

**Costo.** La funzione principale del sito non produceva nulla di utile per quattro leghe su
cinque, e il messaggio d'errore («quote non trovate») puntava verso la chiave API o il servizio,
cioè nella direzione sbagliata. Chi lo usava concludeva che l'integrazione fosse rotta.

**Perché nessuno l'ha visto.** La pagina principale usa `defaultRound`, che *era* restituito e
valeva correttamente 2. I test della schedina esercitavano l'algoritmo di composizione, mai la
selezione del turno.

**Cosa lo intercetta ora.** `tests/schedina-matchday.test.js` verifica che `firstUpcoming` sia
nell'oggetto restituito e che sia il primo turno con gare ancora da giocare.

→ §24

---

## 5. La schedina componeva giocate su partite finite

**Cosa.** Un turno non è un blocco atomico — la giornata 3 di Liga 2026-27 va dal 25 al 29 agosto
— e la schedina costruiva candidati su tutte le gare del turno, comprese quelle già concluse.

**Costo.** Poteva proporre una scommessa su una partita del giorno prima, e contava quelle gare
nel minimo di selezioni richieste.

**Perché nessuno l'ha visto.** Mascherato dal difetto 4: finché il turno scelto era sempre il
primo della stagione, il caso "turno parzialmente giocato" non si presentava mai.

**Cosa lo intercetta ora.** `upcomingFixtures()`, che scarta il concluso **e** il passato — il
flag `completed` da solo non basta, perché una gara di stamattina può non essere ancora stata
ingerita. Verificato per mutazione.

→ §24

---

## 6. `lineup_strength` costante, presentato come misura

**Cosa.** `build_player_context()` chiama
`compute_lineup_strength(lineup, players, reliability)` dove `lineup` passa da `rounded_player()`
— che **aggiunge** il campo `impact` — e `players` no. Il ripiego di `impact_of()` sostituiva i
minuti, con un commento che diceva «restano confrontabili perché il rapporto li normalizza». Non
li normalizza: il numeratore sommava `impact` (~10-20 a giocatore), il denominatore `minuti`
(~180-270). Rapporto ~0.06 per ogni squadra, schiacciato sul minimo del clamp.

**Costo.** `lineup_strength = 0.92` su tutte e 100 le squadre coperte: una costante spacciata per
una misura. Impatto sulle previsioni **nullo**, perché il difetto 1 aveva già scollegato
`teamContext` dalla produzione — ma sarebbe stato attivo il giorno in cui lo si riprendesse.

**Perché nessuno l'ha visto.** Il ripiego rendeva il difetto possibile *per costruzione*, e la
motivazione scritta nel commento era plausibile e sbagliata. I contratti di distribuzione l'hanno
poi intercettato, ma solo dopo che il dato era già nel dataset pubblicato.

**Cosa lo intercetta ora.** `impact_of()` **ricalcola** con `player_score()` invece di sostituire.
Due test sulla funzione: il risultato non deve dipendere dalla forma dei dizionari (quattro
combinazioni grezzo/arrotondato entro 1e-3) e un undici più debole deve abbassare il fattore.

→ §25.2

---

## 7. La fusione delle grafie stava fuori dalla pipeline

**Cosa.** `resolve_spelling_collisions()` — che fonde `Malaga`/`Málaga` e simili — viveva solo in
`repair_dataset_identities.py`, cioè in uno strumento da lanciare a mano.

**Costo.** La rigenerazione automatica gira **quattro volte al giorno**: reintroduceva lo split a
ogni esecuzione. Il contratto lo intercettava, ma qualcuno doveva accorgersene ed eseguire la
riparazione. Il 28/08/2026 `esp.1` aveva 21 identità per un campionato da 20.

**Perché nessuno l'ha visto.** Era "già risolto": lo strumento esisteva e funzionava. Nessuno
aveva verificato che il difetto non tornasse da solo.

**Cosa lo intercetta ora.** La funzione è in `update_europe_data.py` e la pipeline la applica
**prima di `compute_elo`** — dopo sarebbe inutile, perché l'Elo resterebbe calcolato sulle
identità spezzate. Lo strumento di riparazione la importa invece di ridefinirla, e un test
verifica sia l'identità delle due funzioni sia l'ordine nel sorgente.

→ §25.1

---

## 8. Le selezioni della schedina finivano dentro un `<input>`

**Cosa.** `schedina.html` aveva **due elementi con `id="schedina-legs"`**: l'`<input type="number">`
del campo «Numero di partite» (riga 39) e il `<div>` dei risultati (riga 99).
`getElementById` restituisce il primo in ordine di documento, quindi
`$("schedina-legs").innerHTML = slip.legs.map(legRow)` scriveva le selezioni **dentro l'input**,
che non renderizza figli.

**Costo.** La schedina si generava correttamente — quote di mercato abbinate 10 su 10, slip
valida — e non compariva. Il caso peggiore per chi debugga: nessuna eccezione, stato verde
«Fatto.», sezione visibile e vuota. Sembrava un problema dell'API delle quote, che era l'unica
cosa a funzionare.

**Perché nessuno l'ha visto.** Il codice legge lo stesso id in due modi — `.value` per il form,
`.innerHTML` per i risultati — e il primo funzionava per caso, perché l'input viene prima nel
documento. Nessun test toccava il DOM.

**Cosa lo intercetta ora.** `tests/dom-contract.test.js`: nessuna pagina può avere id duplicati, e
ogni id cercato con `$("...")` deve esistere nella pagina che carica quel modulo.

→ §26

---

## 9. Due matcher diversi per le stesse partite

**Cosa.** `matchOddsToFixtures` (quote 1X2) abbina i nomi con `namesMatch()`, tollerante al
contenimento. `collectPlayerOdds` (quote sui marcatori) usava l'uguaglianza esatta fra nomi
normalizzati.

**Costo.** Sulle stesse identiche fixture: 1X2 abbinate 10 su 10, marcatori 7 su 10. La
differenza si leggeva come una lacuna del bookmaker — «quel mercato non è offerto» — mentre era
un'incoerenza interna. In più le due strade interrogavano regioni diverse (`eu` contro `us`)
senza che nulla lo dicesse.

**Perché nessuno l'ha visto.** Il resoconto diceva «trovate per 7/10» senza distinguere fra
«partita non abbinata» (problema nostro) e «mercato non offerto» (scelta del bookmaker). Le due
cause hanno rimedi opposti e venivano contate insieme.

**Cosa lo intercetta ora.** Le due strade usano lo stesso matcher, verificato da un test sul
sorgente; il resoconto distingue le due cause e dichiara la regione interrogata.

→ §26

---

## 17. Un id rinominato, e l'errore non diceva quale

**Cosa.** La correzione del difetto 8 ha rinominato il contenitore dei risultati della schedina
(`schedina-legs` -> `schedina-selections`) in `schedina.html` e in `schedina-page.js`. Un browser
con la **pagina vecchia in cache** e lo **script nuovo** cerca un id che quella pagina non ha:
`$("schedina-selections")` torna `null` e l'assegnazione fallisce.

**Costo.** La pagina mostrava `Errore: Cannot set properties of null (setting 'innerHTML')`, che
non nomina l'elemento mancante e soprattutto punta nella direzione sbagliata: sembra un difetto
del codice appena scritto, mentre il codice sul disco e' coerente e la generazione della schedina
funziona (verificata su tutte e otto le competizioni, con e senza mercati sui giocatori).

**Perche' nessun test l'ha visto.** `tests/dom-contract.test.js` verifica la coerenza fra la
pagina e il modulo **cosi' come stanno nel repository**, ed e' verde: entrambi sono della stessa
versione. Cio' che il browser ha caricato e' un'altra cosa, e nessun test locale puo' vederlo. La
rinomina di un id e' quindi una modifica retro-incompatibile verso le copie gia' servite, esattamente
come lo sarebbe un cambio di formato del payload.

**Cosa lo intercetta ora.** `$()` in `schedina-page.js` non torna piu' `null`: solleva un errore
che nomina l'id mancante e dice che pagina e script devono essere della stessa versione
(ricaricare forzando l'aggiornamento). Il messaggio arriva all'utente attraverso il gestore di
errori gia' presente.

---

## 18. Il sito pubblicato serviva un dataset diverso da quello validato

**Cosa.** La pipeline e' in due passi — `update_top5_data.py` costruisce, poi
`enrich_competitions_players.py` arricchisce — ed e' cosi' che gira in locale e in
`update-data.yml`, che committa `data/matches.json` quattro volte al giorno. `pages.yml` pero'
**ricostruiva il dataset per conto suo** prima di pubblicare, con `--skip-understat` e senza il
secondo passo, sovrascrivendo in checkout il file appena validato.

**Costo.** Il sito pubblicato serviva un dataset senza `player_context` (niente mercati sui
giocatori, niente formazioni probabili: la scheda si limita a mostrare meno cose, senza dire
perche') e senza xG reali — e l'xG e' la feature con l'esponente piu' alto del modello (0.43 in
attacco, 0.45 in difesa). Dove manca, `xgValue()` ripiega su `0.16 + 0.026·tiri +
0.19·tiriInPorta`: il sito non pesava xG 0.43 e tiri 0.25, pesava tiri 0.68. In locale
il difetto era invisibile per costruzione, perche' in locale i due passi si lanciano entrambi.

**Perche' nessun test l'ha visto.** Nessun test guarda cosa viene *pubblicato*: girano tutti sul
dataset presente nel repository, che era quello giusto. Il controllo che il deploy gia' faceva
verificava le competizioni e la dimensione — due proprieta' che il dataset degradato soddisfa —
e sulla versione non poteva dire nulla, perche' `enrich_competitions_players.py` riscriveva
`model_inputs_version` da `4.1-top5-uefa-core` a `3.1-multi-league-player-lineups` — un passo
successivo che dichiarava una versione piu' bassa del precedente, quindi una stringa che non
distingueva «arricchito» da «costruito con un altro script». Un
dataset senza xG e senza rose non solleva eccezioni: produce previsioni plausibili e una scheda
con meno sezioni.

**Cosa lo intercetta ora.** `pages.yml` non ricostruisce piu' nulla: pubblica il dataset del
repository, quello che `update-data.yml` ha costruito, arricchito e validato. Il controllo pre-deploy
verifica ora le quattro cose che il difetto azzerava: versione uguale a quella scritta da
`update_top5_data.py`, `player_context` non vuoto, almeno una gara con xG reale, e la dimensione
entro il limite. `enrich_competitions_players.py` non riscrive piu' la versione: identifica chi ha
costruito il dataset, e l'arricchimento si attesta con il campo che aggiunge.

---

## 19. La Bundesliga austriaca rendeva ambiguo il campionato tedesco

**Cosa.** `discoverSportKey()` individuava il campionato su the-odds-api cercando una parola
chiave nel titolo/descrizione del catalogo sport, e accettava il risultato solo se **unico**.
Per `ger.1` il termine e' "bundesliga", che nel catalogo corrisponde a tre voci: la Bundesliga
tedesca, la "Bundesliga 2" (esclusa da un blocklist) e la **Bundesliga austriaca**, che nessun
blocklist escludeva ed e' attiva negli stessi mesi.

**Costo.** Per la Bundesliga la scoperta automatica non era mai univoca: la pagina cadeva sempre
sul percorso di scelta manuale del campionato. Dal lato utente si legge come «non trova le
quote», e non c'e' niente nel messaggio che suggerisca che il problema e' un omonimo austriaco.

**Perche' nessun test l'ha visto.** Nessun test toccava `discoverSportKey`: la funzione parla con
la rete, e il catalogo altrui non era stato riprodotto da nessuna parte. La scoperta dinamica era
stata scelta *apposta* per non dipendere da chiavi non verificabili da qui — ma il ripiego scelto
dipendeva da un testo altrettanto non verificabile, e per giunta ambiguo.

**Cosa lo intercetta ora.** `LEAGUE_SPORT_KEYS`: i `sport_key` documentati (`soccer_epl`,
`soccer_spain_la_liga`, `soccer_italy_serie_a`, `soccer_germany_bundesliga`,
`soccer_france_ligue_one`) sono provati per primi sul catalogo, e la ricerca per parola chiave
resta solo come ripiego. `tests/odds-matching.test.js` fissa un catalogo con la voce austriaca
dentro e pretende la chiave giusta per tutte e cinque le leghe.

---

## 20. "Paris" e "Paris Saint Germain" erano la stessa squadra per il matcher delle quote

**Cosa.** `namesMatch()` considerava abbinati due nomi se uno era **sottostringa** dell'altro, e
`matchOddsToFixtures` cercava un evento per volta con `find()`. Due conseguenze opposte:
`"M'gladbach"` contro `"Borussia Monchengladbach"` e `"Rennes"` contro `"Stade Rennais"` non
condividono alcuna sottostringa e restavano senza quote; `"Paris"` (che in Ligue 1 e' il Paris
FC) e' contenuto in `"Paris Saint Germain"`, quindi le due partite potevano prendersi l'evento
l'una dell'altra.

**Costo.** Sulle prime due, quota equa del modello al posto di quella di mercato, dichiarata come
«stima»: perdita di informazione, ma onesta. Sulla terza, **le quote di un'altra partita usate
come vere** — la schedina le tratta come mercato reale e ci cerca sopra il valore. E' un errore
peggiore di una quota mancante, e non lascia traccia. Entrambi i club esistono nel dataset della
stagione in corso, quindi il caso non e' teorico.

**Perche' nessun test l'ha visto.** Il test esistente provava un solo abbinamento riuscito
(`Bayern Monaco` -> `Bayern Munich`) e uno mancato. Nessuno provava un turno intero con due
squadre dai nomi vicini, che e' l'unica configurazione in cui uno scambio puo' avvenire: una
partita alla volta, ogni abbinamento sembra corretto.

**Cosa lo intercetta ora.** `assignEventsToFixtures()` risolve il turno intero invece di una
partita per volta — ogni evento va a una sola partita, le coppie piu' somiglianti scelgono per
prime — e confronta i nomi per token con due misure distinte: la copertura decide chi e'
ammissibile, l'indice di Jaccard decide chi vince fra piu' ammissibili (`Paris`/`Paris FC` vale
1, `Paris`/`Paris Saint Germain` vale 0.33). I nomi senza radice comune stanno in una tabella di
alias, che e' l'unica cosa che possa risolverli. `tests/odds-matching.test.js` prova un turno per
ciascuna delle cinque leghe con l'ordine degli eventi invertito, e verifica **a quale evento**
ogni partita e' stata agganciata, non solo che lo sia stata.

---

## 21. L'ottimizzatore confrontava quote eque e quote di mercato come se fossero la stessa cosa

**Cosa.** Solo `1`, `X` e `2` potevano portare una quota reale (`LIVE_ODDS_BY_KEY`): doppia
chance, Over/Under e Gol/No gol usavano sempre la quota equa del modello, anche con una chiave
API valida. La schedina pero' massimizza `Σ ln(quota)` mettendo le due cose nella stessa somma —
e non sono sulla stessa scala. Con la quota equa vale `ln(quota) = -ln(p)` esattamente; una
quota di mercato e' piu' bassa, perche' contiene il margine del banco.

**Costo.** A parita' di probabilita' una selezione "stima" **sembrava pagare piu'** di una di
mercato, quindi la ricerca le preferiva sistematicamente: la schedina si riempiva proprio dei
mercati per cui non avevamo un prezzo vero. Su una schedina reale osservata (2 gambe di mercato
+ 2 doppie chance stimate) la quota combinata mostrata era 5.96 con ritorno atteso 1.202 —
un +20% che non esiste: alle doppie chance prezzate come le prezza un banco la stessa schedina
vale 5.38. Il numero mostrato all'utente non era ottenibile.

**Perche' nessun test l'ha visto.** I test sulle quote provavano l'abbinamento (questa partita e'
quell'evento) e l'ottimizzatore (dato un paniere di candidati, la combinazione giusta), mai i due
insieme. Ogni pezzo era corretto: il difetto stava nel fatto che il paniere conteneva prezzi di
due tipi e nessuno dei due pezzi poteva accorgersene. In piu' la quota equa e' *plausibile* per
costruzione — 1.08 per un 92% e' esattamente 1/0.92 — quindi non c'e' niente da notare guardando
i numeri.

**Cosa lo intercetta ora.** Ogni mercato che un bookmaker prezza ha ora un prezzo di mercato:
doppia chance derivata **esattamente** dalle tre quote 1X2 (`1/(1/oA + 1/oB)`, nessuna richiesta
in piu'), Over/Under dal mercato `totals` alla linea corrispondente, Gol/No gol da `btts`. Le
linee che il bookmaker non espone non si estrapolano: restano quota equa, dichiarata. I mercati
si chiedono all'API solo se l'utente ha acceso quel gruppo, perche' ogni mercato x regione e' una
richiesta del piano gratuito. `tests/odds-matching.test.js` verifica la derivazione, la
provenienza di ogni selezione e i mercati che finiscono nella richiesta.

---

## 22. Un mercato non-featured faceva fallire tutta la richiesta di quote

**Cosa.** La correzione del difetto 21 chiedeva all'endpoint di lega `markets=h2h,totals,btts`.
`/v4/sports/{sport}/odds` accetta pero' solo i mercati **featured** (`h2h`, `spreads`, `totals`,
`outrights`): i non-featured — `btts`, linee alternative, player prop — esistono solo
sull'endpoint per singolo evento.

**Costo.** Non una selezione in meno: **HTTP 422 `INVALID_MARKET` sull'intera chiamata**, quindi
nessuna quota reale, comprese le 1X2 che erano perfettamente disponibili. Un mercato marginale in
piu' toglieva tutti gli altri. Nella pagina si leggeva «Quote reali non disponibili (...): usate
le quote eque del modello», cioe' il ripiego corretto per una causa sbagliata.

**Perche' nessun test l'ha visto.** Il test verificava che i mercati chiesti finissero nell'URL —
e ci finivano. Quello che non poteva sapere e' quali mercati quell'endpoint accetta: e' una
regola dell'API altrui, e da qui non c'e' modo di interrogarla. La correzione del difetto 21 era
stata scritta assumendo che `btts` fosse chiedibile come `totals` perche' entrambi sono
documentati per il calcio — vero, ma su endpoint diversi. **La distinzione featured /
non-featured non era stata cercata, era stata data per non esistente.**

**Cosa lo intercetta ora.** `FEATURED_MARKETS` e' esplicito, `oddsMarketsFor()` filtra su quello,
e `tests/odds-matching.test.js` verifica per ogni combinazione di gruppi che nessun mercato
non-featured possa finire nella richiesta di lega. Gol/No gol torna a essere quota equa
dichiarata: prezzarlo davvero richiede una chiamata per partita, che e' una decisione di costo,
non un dettaglio implementativo.

---

## 23. Le quote sui giocatori non si agganciavano quasi mai

**Cosa.** I nomi dei giocatori nel dataset vengono da ESPN e sono **abbreviati** — `F. Conceição`,
`R. Kolo Muani`, `W. McKennie` — mentre l'API di quote usa il nome completo. L'abbinamento era
un'uguaglianza fra nomi normalizzati, quindi passavano solo i mononimi (`Bremer`) e nient'altro.

**Costo.** Le quote reali sui marcatori erano di fatto inutilizzabili, e — questo e' il punto —
il resoconto **non lo diceva**: contava una partita come risolta quando l'API rispondeva, non
quando un giocatore veniva prezzato. Si leggeva «quote reali sui marcatori trovate per 10/10
partite» mentre nessun giocatore aveva un prezzo di mercato e ogni selezione usava la quota equa
etichettata «stima». Le due letture sono opposte e nulla le distingueva.

**Perche' nessun test l'ha visto.** Le fixture dei test contenevano nomi gia' allineati fra le due
parti, perche' erano state scritte guardando la funzione invece che i dati. Il formato reale dei
nostri nomi — con l'iniziale puntata — non compare in nessun test: e' nel dataset, e nessuno era
andato a leggerlo. Stessa forma del difetto 10 (`minutes` sempre popolato nelle fixture, mai in
produzione).

**Cosa lo intercetta ora.** `playerMarketPrice()` confronta i soli token di cognome, scartando le
iniziali puntate, e pretende che il cognome corrisponda a un **unico** nome dell'API. Con piu' di
un candidato decide l'iniziale, e se resta ambiguo non restituisce alcun prezzo: Marcus e Khéphren
Thuram giocano nello stesso campionato, e una quota attribuita al fratello sbagliato e' peggio di
una quota mancante. `tests/odds-matching.test.js` usa i nomi nel formato del dataset vero, i due
Thuram inclusi.

---

## 24. La quota totale della schedina era calcolata, scritta e invisibile

**Cosa.** `renderSlip()` scriveva il riepilogo — numero di selezioni, **quota combinata**,
probabilita' stimata, ritorno atteso — in `#schedina-summary`, che era un `<p>` dentro
`.settings-card__heading`. `ui-cleanup.css` nasconde quei `<p>` con `display: none !important`
perche' sono copia esplicativa, e la regola in se' e' giusta: sbagliato era metterci dentro un
**risultato**.

**Costo.** Il numero per cui si apre quella pagina non compariva. La schedina mostrava le
selezioni con le loro quote singole e nessun totale, e l'utente ha chiesto «aggiungi la feature
che mi dica la quota totale» per una feature che c'era gia', completa di ritorno atteso e
sicurezza raggiunta.

**Perche' nessun test l'ha visto.** `tests/dom-contract.test.js` verificava che ogni id cercato
dal JS esistesse nella pagina — e `#schedina-summary` esisteva. Nessuna eccezione, nessun id
mancante, testo regolarmente scritto nel DOM: mancava solo il pixel. E' la stessa forma del
difetto 8 (le selezioni dentro un `<input>`), su un confine diverso: li' HTML contro JS, qui CSS
contro HTML.

**Cosa lo intercetta ora.** Il riepilogo e' un `<div>` fuori dall'intestazione, e
`tests/dom-contract.test.js` legge le regole di `ui-cleanup.css` e fallisce se un id in cui il JS
scrive finisce dentro un blocco che quel foglio nasconde — eccezioni `:not(#...)` comprese.
Verificato rimettendo l'elemento dov'era: il test fallisce.

---

## 25. Il "divario dal mercato di chiusura" era misurato contro l'apertura

**Cosa.** `parse_csv()` leggeva `AvgH/B365H/PSH`, che nel formato Football-Data.co.uk sono le
quote di **apertura**. Le colonne di chiusura hanno una C prima dell'esito (`AvgCH`, `PSCH`),
stanno nello stesso CSV gia' scaricato, e venivano scartate. README, `backtest_vs_market.mjs` e
ogni misura del divario le chiamavano pero' "quote di chiusura".

**Costo.** Il numero piu' citato del progetto — il divario dal mercato, +0.0214 ± 0.0028 — era il
divario dalla linea di **apertura**, che e' piu' debole e quindi piu' facile da avvicinare.
Rimisurato contro la chiusura sulle stesse 3551 gare: **+0.0231 ± 0.0030 (7.7σ)**. La conclusione
non cambia di segno — il mercato era davanti e resta davanti — ma ogni frase del tipo "il divario
si e' dimezzato" era calcolata contro il benchmark sbagliato, e in direzione lusinghiera.

**Perche' nessun test l'ha visto.** Le colonne esistono entrambe e contengono entrambe numeri
plausibili: `6.31` e `7.03` sono tutte e due quote credibili per la stessa partita. Nessun test
guardava i nomi delle colonne, e il commento sopra la riga *diceva* "chiusura" — cioe' la stessa
forma dei difetti 2 e 6, dove un commento plausibile e falso motivava una scorciatoia che nessuno
aveva verificato.

**Cosa lo intercetta ora.** `parse_csv()` estrae apertura **e** chiusura in campi distinti
(`home_odds` contro `home_odds_close`), piu' miglior prezzo di chiusura, Over/Under 2.5 e handicap
asiatico. `backtest_vs_market.mjs` usa la chiusura e **dichiara nel risultato** contro quale linea
ha misurato (`marketLine`), perche' un numero che non dice quale benchmark usa non e'
interpretabile. `tests/test_closing_odds_columns.py` verifica che i due campi leggano colonne
diverse, che un CSV senza colonne di chiusura lasci i campi a `None` invece di ricadere
sull'apertura, e che i campi sopravvivano a `compact_match()`.

---

## 26. Lo storico "permanente" viveva in una cache del browser

**Cosa.** `storico.html` dichiarava che «le schedine generate restano qui», ma l'unico posto in
cui restavano era `localStorage`. Che non e' un archivio: e' legato all'**origine** e ai dati del
sito. Aprire l'app su una porta diversa (`npm start -- --port 8080`), pulire i dati di Chrome,
passare a un altro browser o a un'altra macchina, e lo storico risultava vuoto — con lo stesso
identico aspetto di «non hai mai generato niente». Nessun errore, nessuna riga in console: la
pagina mostrava serenamente «Nessuna schedina salvata».

**Costo.** Nessun effetto sulle previsioni, ma cancellava l'unica misura che il progetto abbia
sui propri numeri dichiarati: la calibrazione delle schedine si costruisce per accumulo, e
servono centinaia di serie prima che dica qualcosa. Un archivio che si azzera a ogni pulizia
della cache non arriva mai a quel numero — cioe' la funzione era, di fatto, inesistente.

**Perche' nessun test l'ha visto.** Tutti i test dello storico usavano un `fakeStorage()` che
sopravviveva per definizione all'intero test: verificavano che «salva e rileggi» funzionasse,
che e' esattamente cio' che funzionava. Nessuno poteva verificare la sola cosa che contava — che
i dati sopravvivessero al **ciclo di vita dello storage**, che in un test in memoria non esiste.
E' la variante di storage del difetto 16: un meccanismo testato in isolamento passa i test anche
quando il contesto reale lo azzera.

**Cosa lo intercetta adesso.** L'archivio e' `data/slip-history.json`, scritto da
`PUT /api/slip-history` (l'unico endpoint di scrittura del progetto, esposto solo da
`scripts/serve.mjs`) e riletto come file statico, quindi anche dove non si puo' scrivere.
`localStorage` resta, ma degradato a cache dichiarata: le due copie si **uniscono per id**, mai
si sostituiscono, cosi' che una copia vuota non possa cancellare l'altra.
`tests/slip-archive-endpoint.test.js` avvia il server vero, scrive, rilegge dal percorso statico
che usa il client e verifica che una forma sbagliata venga **rifiutata invece che scritta**;
`tests/slip-history.test.js` copre l'unione, la potatura della sola cache e la permanenza delle
vincite. E la pagina adesso dice in quale dei due casi si trova, invece di promettere una
permanenza che non poteva mantenere.

---

## 27. La fusione delle grafie non era sul percorso che gira davvero

**Cosa.** La correzione del difetto 7 aveva messo `resolve_spelling_collisions()` in
`update_europe_data.main()`. Ma `update-data.yml` non esegue quel `main()`: l'entry point della
rigenerazione automatica e' `update_top5_data.py`, che la fusione non l'ha mai chiamata.
`enrich_competitions_players.py` — l'ultimo a scrivere — la applicava in uscita, pero' solo
**rinominando**: la deduplica di `merge_matches()` era gia' avvenuta quando i due nomi erano
ancora diversi, quindi le due righe restavano due righe, ora con lo stesso nome. La correzione
c'era su due percorsi e nessuno dei due la completava.

**Costo.** Il Malaga, neopromosso in Liga 2026-27, e' scritto `Malaga` da Football-Data.co.uk e
`Málaga` da ESPN. Nel dataset rigenerato, Atletico-Malaga del 19/08/2026 e Malaga-Deportivo del
24/08 comparivano due volte ciascuna, e `esp.1 2627` contava 21 identita' per un campionato da
20. Sul sito nulla: `pages.yml` pubblica il dataset **committato**, e l'ultimo committato era
stato prodotto dalla pipeline precedente. Il costo misurato e' che la rigenerazione automatica e'
ferma dal 29/08/2026 — sette esecuzioni consecutive fallite, il dataset pubblicato invecchia di
un giorno ogni giorno.

**Perche' nessun test l'ha visto.** Al contrario: e' un test che l'ha visto, appena e' esistito.
`test_dataset_identity_contract.py` e' arrivato su `main` con il merge del 29/08/2026 e ha
intercettato il difetto alla prima rigenerazione. Cio' che nessun test copriva e' l'**ordine
delle chiamate nei due percorsi di scrittura**: `test_main_applies_the_collapse_before_computing_elo`
verificava il sorgente di `update_europe_data.py`, cioe' proprio il percorso che la CI non
esegue. Un controllo scritto su un percorso non dice niente sull'altro, e la lezione del difetto
7 — «la correzione deve stare su OGNI percorso che scrive» — era gia' scritta a commento del
codice che la violava.

**Cosa lo intercetta adesso.** Entrambi i percorsi di scrittura fondono e poi **ricompongono**.
`update_top5_data.py` fonde le grafie prima di `merge_matches()`, cosi' che la deduplica avvenga
sui nomi gia' uniti. `enrich_competitions_players.py` fonde prima di `compute_elo()` e
`build_team_context()` — non solo prima di scrivere: fonderle dopo unirebbe i nomi lasciando
l'Elo calcolato sulle identita' spezzate, cioe' correggerebbe l'etichetta e non il dato — e
riallinea alla stessa grafia le chiavi di `team_context` e `player_context`, gli aggregati
derivati (`referee_stats`) e i conteggi di `coverage`, che dopo una deduplica non possono
restare quelli di prima.

`tests/test_team_name_normalization.py::CollapseOnEveryWritingPathTests` verifica l'ordine in
entrambi i sorgenti e, per mutazione, che sia la rinomina da sola a non bastare: due righe della
stessa partita con grafie diverse restano due anche dopo essere state rinominate, e tornano una
sola — con le statistiche delle due fonti unite — solo se si rideduplica.

---

## 28. Un test di integrazione che scadeva con il calendario

**Cosa.** `tests/odds-cache.test.js` verifica che la seconda schedina dello stesso turno non
ricompri le quote, e per farlo chiama `generateSlip()` sul dataset vero. `generateSlip()` sceglie
il primo turno con gare non concluse e poi scarta da quel turno le gare gia' passate (difetto
24): se il dataset e' piu' vecchio del calendario, il turno "aperto" e' fatto solo di gare
passate, non resta niente su cui costruire e la funzione solleva — correttamente, perche' nessuna
API di quote espone eventi conclusi. Il test pero' non distingueva quel caso da un difetto della
cache: lo lasciava propagare e diventava rosso.

**Costo.** Nessun effetto sulle previsioni, ma un guasto a cascata sulla CI. `update-data.yml`
era fermo dal 29/08/2026 per il difetto 27, quindi il dataset committato ha smesso di essere
aggiornato; il 01/09/2026 le ultime due gare aperte del turno 2 di Serie A sono finite nel
passato e `npm test` e' diventato rosso **anche in `pages.yml`**, che fino a quel momento era
l'unico workflow verde. Un difetto nella pipeline dati bloccava cosi' anche la pubblicazione del
sito, per una via che non ha niente a che vedere con la pipeline dati.

**Perche' nessun test l'ha visto.** Perche' e' il test stesso. Era gia' scritto per saltare
senza fallire quando `data/matches.json` non c'e' — la condizione «dati assenti» era prevista —
ma non quando i dati ci sono e sono **stantii**. E' la stessa distinzione del difetto 24: il caso
«turno parzialmente giocato» non si presenta mai finche' si lavora il giorno stesso in cui il
dataset viene rigenerato, e la CI lo rigenerava quattro volte al giorno. La condizione e'
comparsa il primo giorno in cui quella rigenerazione si e' fermata.

**Cosa lo intercetta adesso.** Il test replica la selezione del turno con le **stesse** funzioni
di `generateSlip()` (`buildMatchdays` e `upcomingFixtures`, entrambe esportate) e, se il turno
scelto non ha almeno due gare da giocare, salta dichiarando che il dataset locale e' piu' vecchio
del calendario — invece di far fallire il deploy. Su un dataset fresco il contratto sulla cache
resta verificato: entrambi i casi sono verificati per mutazione, il salto sul dataset del
28/08/2026 e l'esecuzione piena sullo stesso dataset con le gare passate marcate concluse.

---

## 29. Il turno 1 era l'ultima giornata di campionato

**Cosa.** `apply_double_round_robin_order` ricostruiva le giornate spezzando l'elenco ufficiale
ESPN (`.../seasons/{anno}/types/1/events`) in blocchi da mezze-squadre e numerandoli
nell'ordine ricevuto. Tre ipotesi implicite, e nel 2026-27 tutte e tre false: che l'elenco sia
raggruppato per giornata (per `ita.1` ed `eng.1` non lo e', 38 blocchi su 38 contengono una
squadra due volte, e la funzione rifiutava tutto ripiegando sul raggruppamento euristico per
data); che sia in ordine cronologico (per `esp.1`, `ger.1` e `fra.1` va **dall'ultima giornata
alla prima**); e che un blocco formalmente valido — dieci gare, venti squadre distinte — sia una
giornata vera, quando lo stesso controllo passa anche su dieci gare pescate da giornate diverse.

**Costo.** Tutte e cinque le leghe del dataset pubblicato hanno il calendario 2026-27 sbagliato:
in `esp.1` il "Turno 1" e' il 30/05/2027 e il "Turno 38" il 15/08/2026, in `ger.1` il turno 1 e'
il 22/05/2027, in `fra.1` il 29/05/2027, in `eng.1` il turno 1 va dall'8 al 30 maggio 2027, in
`ita.1` il turno 1 mescola tre giornate vere (22/08 → 13/09/2026). Poiche' `default_round` e' il
primo turno con gare da giocare, `default_round` valeva 1 ovunque: **il sito apriva sull'ultima
giornata di maggio 2027**, ed e' da li' che `generateSlip()` sceglieva le gare della schedina.
Nessun effetto sulle previsioni — il modello non usa il numero di turno — ma la funzione
principale del sito mostrava il campionato al contrario.

**Perche' nessun test l'ha visto.** L'unico test sulla funzione costruiva l'elenco **gia'**
raggruppato per giornata e **gia'** in ordine crescente, e senza date: asseriva le due ipotesi
da verificare invece di metterle alla prova. Il contratto di calendario
(`calendar_contract_issues`) conta le fixture e le giornate — 38 turni da 10 gare — e un
calendario invertito o rimescolato le conta esattamente giuste. E il difetto e' silenzioso per
costruzione: `return False` scrive su stderr e lascia i turni all'euristica, dentro un workflow
di aggiornamento dati di cui nessuno legge lo stderr.

**Cosa lo intercetta adesso.** `double_round_robin_rounds` restituisce il raggruppamento invece
di applicarlo, e `apply_official_round_order` prova **due** ordini — quello ESPN e quello per
data — tenendo il raggruppamento con le giornate piu' compatte nel tempo, che e' cio' che una
giornata e': dieci gare nello stesso fine settimana. Il verso si decide confrontando la data
mediana del primo gruppo con quella dell'ultimo. Tre test in `tests/test_calendar_pipeline.py`
coprono i tre modi di sbagliare (elenco non raggruppato, elenco al contrario, blocchi validi ma
sparsi), ognuno verificato per mutazione: spento il ripiego per data, spento il controllo del
verso o spenta la scelta del piu' compatto, il test corrispondente diventa rosso. Sui dati veri
le cinque leghe passano ora da 0 a 38/38 e 34/34 giornate complete, con il turno 1 in agosto.

---

## 30. Un 503 su una fonte cancellava colonne gia' pubblicate

**Cosa.** Il 05/09/2026 football-data.co.uk ha cominciato a rispondere 503 su tutto il sito
(homepage inclusa, con qualunque User-Agent, http e https). `download_football_data()` cattura
l'errore, lo stampa su stderr e lascia proseguire il run: e' il comportamento voluto, una fonte
giu' non deve bloccare l'aggiornamento di risultati e calendario che ESPN e UEFA danno benissimo.
Ma la pipeline poi riscrive `data/matches.json` **da zero** a partire dai soli feed raggiungibili.
Le colonne che solo Football-Data fornisce non restano com'erano: spariscono. Non esisteva alcun
percorso in cui il dataset conservasse cio' che una fonte irraggiungibile non aveva potuto ridare.

**Costo.** Misurato sui commit del dataset: fra quello delle 12:02 e quello delle 17:03 del 5
settembre, `home_odds` e' passato da 5355 partite a 0, `home_odds_close` da 5355 a 0, `referee`
da 1160 a 0 e `referee_stats` da 34 arbitri a `{}`. Sedici run successivi hanno ripubblicato lo
stesso vuoto, per quattro giorni. **Nessun effetto sulle previsioni**: `prediction-inputs.js` non
legge le quote e il sito ha continuato a funzionare identico. L'effetto e' sulla misura:
`npm run backtest:market` usciva con «Nessuna delle partite valutate ha
home_odds/draw_odds/away_odds», e con lui `diag_market_execution` e `diag_signal_orthogonality` —
cioe' l'intera strumentazione di PROMPT-sessione-4 e -5, che e' anche il posto da cui viene
l'unico guadagno grosso mai misurato (+0.0285 dall'ancoraggio alle marginali di mercato).

**Perche' nessun test l'ha visto.** `tests/test_closing_odds_columns.py` esiste apposta per le
colonne quote, ma lavora su un CSV sintetico: verifica che `parse_csv()` legga le colonne giuste
e che `compact_match()` non le scarti. Entrambe le cose restavano vere — semplicemente non c'era
nessun CSV. Nessun test guardava la copertura quote del **dataset pubblicato**, e tutti i
controlli che il dataset ha (`calendar_contract_issues`, la soglia `len(matches) < 400`, il
contratto di identita') contano righe, giornate e nomi, mai colonne: un dataset con 8557 partite
giuste e zero quote li passa tutti. Il segnale c'era, su stderr, dentro un workflow di cui nessuno
legge lo stderr — lo stesso posto del difetto 29.

**Cosa lo intercetta adesso.** `restore_missing_source_fields()` in `update_top5_data.py` riprende
dal dataset gia' pubblicato i soli campi che solo Football-Data fornisce
(`FOOTBALL_DATA_ONLY_FIELDS`: quote di apertura, chiusura e massime, over-under, handicap
asiatico, arbitro), con `base.match_identity()` — la stessa chiave di `merge_matches()`, ora
estratta in una funzione proprio perche' le due non possano divergere in silenzio. Riempie solo
buchi di partite che i feed live riportano ancora, non sovrascrive mai un valore fresco, e stampa
un ATTENZIONE quando scatta, cosi' l'indisponibilita' smette di essere muta.
`tests/test_source_outage_preservation.py` mette alla prova i tre modi di sbagliarlo (sovrascrivere
un valore fresco, far ricomparire una partita che i feed non riportano piu', divergere dalla chiave
di merge) e aggiunge il contratto che sarebbe diventato rosso il 5 settembre: sulle stagioni
concluse dei Big Five almeno il 90% delle partite deve avere `home_odds`. La copertura reale e'
100%; sul dataset danneggiato il contratto misurava 0.0% su 5255 partite. Il dataset e' stato
riparato applicando la stessa funzione all'ultima versione pubblicata che aveva le quote
(`96a0618`): 97532 campi rimessi su 5354 partite, `backtest:market` di nuovo eseguibile.

---

## 31. Il centraggio azzerava la media, il contratto controllava la mediana

**Cosa.** `center_lineup_strength_factors()` toglie a `lineup_strength` il bias di copertura —
il fattore e' un rapporto fra l'XI probabile e l'XI tipo della **stessa** squadra, quindi essere
coperti dalla pipeline non deve valere di per se' un bonus. Lo faceva traslando la distribuzione
finche' la **media** valeva 1. Ma la distribuzione e' asimmetrica: poche squadre penalizzate
molto, molte penalizzate pochissimo. Con la media a 1 la maggioranza delle squadre resta sopra 1.
Il 09/09/2026, con la media a 1.0000 esatto: mediana 1.0105, **72 squadre su 96 sopra 1** e 24
sotto. Peggio: 51 squadre su 96 hanno il rapporto grezzo **esattamente 1.0** — nessuna notizia di
indisponibilita', XI probabile identico all'XI tipo — e il dataset le pubblicava a **1.0105**. Il
valore che per definizione significa "nessuna informazione" era il piu' frequente del dataset e
non stava su 1. E' il difetto 15 («un fattore che puo' solo premiare, e premia chi la pipeline e'
riuscita a coprire») sopravvissuto alla propria correzione, perche' la correzione centrava la
statistica sbagliata.

**Costo.** **Nessuno sulle previsioni.** `teamContext` e' escluso da `prediction-inputs.js` dal
27/08/2026 (misurato: +0.0002 ± 0.0010 su `fra.1`, 0.21σ), quindi `lineup_strength` non entra in
nessun lambda ne' in produzione ne' in backtest: il campo resta nel dataset, testato, in attesa di
poter essere riacceso — ed e' proprio la condizione in cui un difetto armato da' verde. Il costo
misurabile e' sul cancello: `update-data.yml` esegue `unittest discover` **prima** dello step che
committa il dataset, e il contratto sulla mediana passava o falliva a seconda di come cadeva la
distribuzione del giorno — 1.0017 il 04/09 (verde), 1.0105 il 09/09 (rosso). Un cancello che
protegge il dataset e decide a testa o croce non protegge niente: la prima volta che fosse uscito
rosso in CI, l'aggiornamento del dataset si sarebbe fermato senza che il dataset avesse nulla che
non andasse.

**Perche' nessun test l'ha visto.** Perche' i test erano due e dicevano due cose diverse.
`test_centering_removes_coverage_bias_without_flattening` asseriva la **media** — cioe' esattamente
la quantita' che il codice azzerava per costruzione: un test che non poteva fallire, verde sia sul
codice giusto sia su quello sbagliato. `test_median_is_centred_on_one` asseriva la **mediana** sul
dataset pubblicato, che il codice non garantiva affatto. Il difetto non stava in nessuno dei due:
stava nel fatto che il codice garantiva una statistica e il contratto ne verificava un'altra, e per
undici giorni la distribuzione e' stata abbastanza simmetrica da farli sembrare d'accordo. Nessuno
dei due poteva accorgersene da solo, perche' nessuno dei due nomina la statistica dell'altro.

**Cosa lo intercetta adesso.** `center_lineup_strength_factors()` centra
`statistics.median(values)`, e il docstring dice perche' non la media. Le due reti ora verificano
la **stessa** affermazione: l'unita' asserisce la mediana, verificata per mutazione — rimesso
`sum(values) / len(values)`, il test torna rosso — e il contratto sul dataset controlla la stessa
grandezza che il codice garantisce, quindi smette di essere una monetina. Effetto misurato sul
dataset del 09/09: mediana da 1.0105 a 1.0000, squadre sopra 1 da 72 a 13, sotto 1 da 24 a 31, e le
52 squadre senza notizie di indisponibilita' finiscono esattamente su 1.0000 — che e' cio' che il
rapporto significa. Il campo pubblicato resta quello vecchio finche' non gira
`scripts/recompute_lineup_strength.py` o l'arricchimento completo: la correzione vale per le
esecuzioni future, come nel difetto 15.

**Coda della stessa storia, il giorno dopo.** Rilanciato l'arricchimento, e' diventato rosso un
SECONDO contratto dello stesso file — `test_covered_teams_are_not_systematically_favoured`, che
pretendeva **media == 1** sulle squadre coperte. I due contratti chiedevano cose incompatibili
(uno la mediana, l'altro la media) e su una distribuzione asimmetrica non possono valere insieme:
qualunque centratura ne soddisfa uno e rompe l'altro, ed e' per questo che per undici giorni sono
sembrati d'accordo. La misura che ha sciolto il nodo e' la distribuzione **grezza**, prima di
qualunque centratura: media 0.9874, **mediana 1.0000 esatta**, 38 squadre sotto 1, 41 esattamente
a 1, 17 sopra. Due conseguenze. Primo: il difetto 15 e' gia' corretto **alla sorgente** in
`compute_lineup_strength()` — il fattore non e' piu' a senso unico da solo — e la centratura e' un
residuo che sulla mediana non sposta quasi nulla, mentre sulla media alzava tutti di ~0.0126.
Secondo: quello 0.9874 non e' un bias di copertura, e' una misura — le assenze sono asimmetriche,
una squadra perde piu' da un infortunio di quanto guadagni da un rientro. Pretendere media == 1
chiedeva alla pipeline di cancellare le assenze che aveva appena osservato.

Il contratto e' stato quindi riportato al suo scopo dichiarato, che e' la **unilateralita'** (0
squadre sotto 1 su 95, il difetto 15) e non il livello: devono esistere squadre da entrambe le
parti dell'1, e lo scarto fra la media delle coperte e l'1.0 delle non coperte deve restare entro
0.03 — una soglia che intercetta una deriva vera senza negare il residuo. Verificato per mutazione
**sui dati** e non sul codice: forzate tutte le coperte a >= 1 (difetto 15) diventa rosso,
spostate tutte di -0.05 (deriva) diventa rosso, sui dati veri e' verde.

---

## 32. Le statistiche dei giocatori erano una finestra di due partite, non una stagione

**Cosa.** `choose_summary_events()` aveva `samples_per_team = 2`: ogni esecuzione ricostruiva la
voce di una squadra dalle sue **due partite piu' recenti** e `player_context.update(fresh_context)`
sostituiva quella precedente invece di estenderla. I contatori per giocatore non potevano quindi
crescere in nessun momento della stagione — non erano statistiche stagionali, erano una finestra
mobile larga due. Il commento in `.github/workflows/update-data.yml` («la copertura si ACCUMULA
fra una run e l'altra») e' la frase che ha reso il difetto invisibile: e' vera per **quante
squadre** il dataset copre e falsa per **quante partite** ha ciascuna, e nessuno aveva motivo di
distinguere le due cose.

**Costo.** Misurato sul dataset **pubblicato dalla CI** il 09/09/2026 alle 13:12 (`292d7bc`), con
squadre che avevano gia' giocato da 2 a 7 partite. Delle 103 voci di `player_context` solo 84
corrispondono a una squadra del catalogo; su quelle 84, che sono le uniche che il sito legge:

- `squad_appearances` valeva **1 per 941 giocatori e 2 per 1083. Nessuno a 3.**
- `start_probability` aveva **5 valori distinti su 2024 giocatori**. Non misurava chi gioca
  titolare: misurava quante delle proprie una o due partite campionate un giocatore avesse
  iniziato, cioe' una tabella a cinque caselle con l'etichetta di una probabilita'.
- Con `PRIOR_MINUTES = 360` contro i minuti osservati, il peso del rendimento reale nei tassi per
  90 era mediana 16% e **massimo 33%**: **2024 giocatori su 2024** avevano una statistica in cui
  contava piu' il prior del ruolo del proprio rendimento. Nessuna eccezione.

Le uniche voci che accumulavano davvero — fino a 14 partite — erano le **19 orfane**, quelle sotto
un nome che il resto del dataset non usa ("Stade Rennais" dove le partite dicono "Rennes"). Non e'
una consolazione: accumulavano per sbaglio, perche' il tetto di due e' contato sul nome della
fixture mentre l'aggregato finisce sotto il nome del `summary`, e chiavi diverse vogliono dire
nessun tetto. Sono dati che nessuno legge, mentre le squadre vere corrispondenti restano senza
alcun dato giocatore (difetto separato, vedi in fondo alla voce).

Non resta nel dataset: `schedina.js:747` costruisce da `player_context[team].players` i candidati
marcatore che passa a `estimatePlayerMarkets`, quindi quei numeri finiscono nella schedina, e
`app.js:333` li mostra nella modale.

**Perche' nessun test l'ha visto.** Perche' tutti guardavano **una** esecuzione.
`test_player_minutes_and_roles.py` e `test_player_card_events.py` verificano che da un `summary`
ESPN si estraggano bene minuti, cartellini e ruoli — ed era vero, l'estrazione funzionava. Il
difetto stava in cosa succede alla **seconda** esecuzione, che nessun test faceva partire. Il
contratto sul dataset (`player-context-contract.test.js`) conta squadre, giocatori e moduli — 96,
2215, 14 moduli plausibili — e sono tutte quantita' che una finestra di due partite produce
identiche a una stagione intera. Nessun numero era sbagliato: era sbagliata la finestra su cui
erano calcolati, e la finestra non compare in nessuna asserzione.

**Cosa lo intercetta adesso.** Le voci dichiarano `season` e `counted_events` (schema 4);
`seed_player_samples()` ricostruisce i contatori grezzi dalla voce gia' in cache della stagione in
corso e `fetch_player_samples()` **aggiunge** le sole partite non ancora conteggiate, scartando
riga per riga quelle gia' in conto per quella squadra — necessario perche' ogni `summary` porta le
righe di due squadre e va riletto finche' serve almeno a una.
`tests/test_player_stats_accumulation.py` copre i tre meccanismi e ognuno e' verificato per
mutazione: spento il seme, spento il filtro per riga o rimesso il vecchio criterio di scelta delle
partite, il test corrispondente diventa rosso.

**Resta aperto, ed e' emerso misurando questo:** 12 voci su 96 stanno sotto un nome che il
catalogo non contiene, e le 12 squadre vere corrispondenti (Rennes, Bournemouth, Freiburg,
Augsburg, Hamburg, Union Berlin, Auxerre, ...) non hanno **nessun** dato giocatore. `parse_summary`
normalizza il `shortDisplayName` del `summary` ESPN, che per questi club diverge dal nome che la
stessa ESPN usa nel calendario. L'accumulo non lo tocca: e' un difetto di identita', la famiglia
che e' costata di piu'. La correzione robusta non e' un altro alias ma la chiave che non ha
grafie — l'id squadra ESPN, gia' presente sia nel `summary` sia nelle fixture
(`home_team_id`/`away_team_id`).

E la **prima stesura di quei test era inutile**, il che e' la parte che vale la pena ricordare: si
fermava a due partite, e fino a due una esecuzione senza accumulo produce lo stesso identico
risultato di una con. Passava su entrambe le versioni del codice — su quella corretta e su quella
difettosa — e solo la verifica per mutazione l'ha rivelato. Il test che discrimina e' quello che
arriva alla **terza** partita, oltre il tetto per esecuzione. Piu' l'invariante sul dataset vero
contro il rischio opposto che l'accumulo introduce, contare due volte la stessa partita: nessun
giocatore puo' avere piu' convocazioni delle partite conteggiate, ne' piu' di 100 minuti per
ognuna.

---

## 10-16. Difetti chiusi nelle sessioni precedenti

Riassunti perché il pattern si veda per intero.

| # | difetto | costo | perché nessuno l'aveva visto |
|---|---|---|---|
| 10 | **ESPN non espone i minuti giocati.** La pipeline li leggeva come campo `minutes`, ottenendo 0 | Ogni probabilità di ogni giocatore era esattamente **0%**, mostrata nell'interfaccia come una previsione | Un dato mancante non solleva un'eccezione: produce 0% per tutti. Tutte le fixture dei test avevano `minutes` popolato |
| 11 | **Identità spezzate per grafia** fra ESPN e Football-Data.co.uk | 210 coppie di righe duplicate, Bundesliga con 22 identità per 18 squadre, LaLiga 28 per 20 | La chiave di deduplicazione includeva il nome: nomi diversi, nessuna deduplicazione, ciascuna copia con metà delle statistiche |
| 12 | **Copertura xG crollata** al 35% in `esp.1` e 34% in `ger.1` | La feature con l'esponente più alto del modello era per la maggioranza delle gare un proxy dei tiri | Conseguenza del difetto 9: la chiave di aggancio a Understat non esisteva. Il numero prodotto restava plausibile |
| 13 | **`referee_stats` calcolato in-sample** — il bias di un arbitro includeva la partita da prevedere | Guadagno apparente di **+0.0050 ± 0.0012 (4.2σ)**, il risultato più grande di due sessioni, **interamente falso**: +0.0001 ricalcolato in avanti | Un aggregato precalcolato non dichiara la propria finestra temporale. Il backtest lo usava come se fosse noto in anticipo |
| 14 | **`restDays` sbagliato** | Il carico di lavoro europeo era invisibile alle previsioni domestiche | Il campo esisteva e conteneva un numero credibile |
| 15 | **`lineup_strength` poteva solo premiare** — `avgRating` sempre 6.5 (ESPN espone `rating: null`), `startShare` sempre ≥ 0.5 per costruzione | 0 squadre sotto 1 su 95, e le 95 sopra 1 erano esattamente quelle che la pipeline era riuscita a coprire: un bias a favore della copertura | Due termini inerti per ragioni indipendenti, entrambe invisibili senza guardare la distribuzione |
| 16 | **Ganci inerti** (`newcomerEloDiscount`, `refereeHomeBias`) — parametri che nessun chiamante passava mai | Nessuno: erano documentati, testati e senza effetto | Un parametro testato in isolamento passa i test anche se nessuno lo usa |

→ §12, §17, README Task 1 e Task 13

---

## Cosa ne segue

**Il confine è il posto pericoloso.** Ventiquattro difetti su ventisei stanno fra due componenti, non
dentro uno. Fra due fonti (9, 10, 3), fra produzione e misura (1, 2), fra coppe e campionato (3),
fra due funzioni che formattano lo stesso dizionario (6), fra pipeline e strumento manuale (7),
fra un parametro e i suoi chiamanti (16), fra un id HTML e i due modi di leggerlo (8), fra una regola di stile e il contenuto che colpisce (24), fra il nome di una colonna e ciò che quella colonna contiene (25), fra la versione della pagina servita e quella dello script (17), fra ciò che una pagina promette di conservare e ciò che lo storage conserva davvero (26), fra il workflow che costruisce il dataset e quello che lo pubblica (18), fra i nostri nomi di squadra e quelli del servizio di quote (19, 20), fra la scala di prezzo del modello e quella del mercato (21), fra i mercati documentati e l'endpoint che li accetta (22), fra i nostri nomi di giocatore e quelli del bookmaker (23), fra due funzioni che abbinano le stesse partite (9). I test unitari coprono i componenti; i contratti
coprono i confini, e sono quelli che hanno trovato qualcosa.

**Un valore neutro nasconde il difetto a monte.** Il difetto 2 era invisibile perché i suoi
consumatori sono spenti; il 6 non toccava le previsioni perché il difetto 1 aveva già scollegato
il campo; il 16 era inerte per definizione. Un test che gira ai soli valori di produzione dà verde
su un difetto armato. Da qui la regola: **quando si verifica un meccanismo spento, accenderlo nel
test.**

**Un difetto "già risolto" può tornare da solo.** Il difetto 7 è il caso puro: la correzione
esisteva, funzionava, ed era fuori dal percorso automatico. Correggere il dato e non la pipeline
significa correggere fino al prossimo aggiornamento — che qui è fra sei ore.

**Il commento che spiega perché una scorciatoia è sicura è il posto dove guardare.** I difetti 2 e 6 avevano entrambi un commento che ne motivava la correttezza, e in entrambi i casi la
motivazione era plausibile e falsa. «Il rapporto li normalizza» e «quell'array si ferma al cutoff»
sono affermazioni verificabili che nessuno aveva verificato.

**Nessun difetto è stato trovato cercandolo.** Il 3 è emerso indagando la copertura xG delle coppe;
il 6 e il 7 rigenerando il dataset per un'altra ragione; l'8 e il 9 da uno screenshot di un utente; il 2 interrogando un risultato che
sembrava pulito. L'unica procedura che ha funzionato è stata **non fidarsi di uno zero**.
