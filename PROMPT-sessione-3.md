# PROMPT — Sessione 3

> Continuazione di `BRIEF-v2.md` e `PROMPT-sessione-2.md`. Questo documento ha precedenza su
> entrambi. Leggere §0 e §1 prima di qualsiasi altra cosa: §1 contiene un difetto trovato dopo la
> chiusura della sessione 2 che invalida il presupposto di ogni misura fatta finora.

---

## 0. Cosa hanno stabilito due sessioni

Nove ipotesi indipendenti testate e respinte con doppia finestra. Le uniche modifiche che
cambiano le previsioni sono **correzioni di dati e definizioni**, mai un parametro: alias delle
squadre, rilevamento neopromosse, `lineup_strength`, `restDays`, cablaggio arbitro.

Zero parametri nuovi in produzione dopo due sessioni.

Questo è un risultato, non un fallimento — ma è anche un pattern abbastanza forte da vincolare
ciò che ha senso provare ancora. **Continuare a testare varianti strutturali non è più
giustificato dall'evidenza.** Le tre piste di questo documento sono scelte perché nessuna
appartiene alla famiglia già respinta.

Da conservare come conoscenza acquisita, in aggiunta a §4 del prompt sessione 2:

- **Il divario dal mercato è più grande di quanto si credesse**: +0.0214 ± 0.0028 (7.6σ) misurato
  appaiato, non 0.017 stimato dal README.
- **Il leakage produce risultati grandi e falsi.** Il bias arbitro dava +0.0050 ± 0.0012 (4.2σ),
  il risultato più grande di due sessioni. Ricalcolato in avanti: +0.0001 ± 0.0010. Era
  interamente contaminazione, perché `compute_referee_stats()` calcolava il bias di ogni arbitro
  **anche dalla partita da prevedere**.
- **Correggere un difetto di calibrazione misurato non paga.** Nove volte su nove. La coda bassa
  è sovrastimata a −3.67σ e i pareggi sono sotto-previsti di 1.3pp: entrambi reali, entrambi
  corretti, entrambi senza guadagno fuori campione.

---

## 1. Il difetto trovato dopo la chiusura della sessione 2

**Il modello che gira in produzione non è il modello che le misure hanno validato.**

```
app.js:200                    →  teamContext: payload?.team_context || null
scripts/backtest_model.mjs    →  NON passa teamContext
scripts/backtest_vs_market.mjs→  NON passa teamContext
scripts/fit_calibration.mjs   →  NON passa teamContext
scripts/tune_hyperparameters.mjs → NON passa teamContext
```

Ogni numero di log loss prodotto in due sessioni viene da un modello con `teamContext = null`,
cioè `lineup_strength = 1` per tutte le squadre. La produzione applica un fattore che dopo Task 13
vale **[0.9480, 1.0454]** — e lo applica a **95 squadre su 303**, lasciando le altre a 1.

### 1.1 La divergenza, misurata

Misura eseguita sul repo al 25/08/2026 con `scripts/diag_prod_vs_measured.mjs` (allegato):
stesse partite, due configurazioni, confronto appaiato.

```
ita.1, 768 gare dal 2024-08-01
  GARE TOCCATE        : 478/768 (62.2%)
  log loss MISURATO   : 0.9863     (teamContext = null, ciò che ogni backtest vede)
  log loss PRODUZIONE : 0.9863     (teamContext passato, ciò che gira su app.js)
  differenza appaiata : -0.0000 ± 0.0006   IC [-0.0012, 0.0012]

eng.1, 769 gare dal 2024-08-01
  GARE TOCCATE        : 0/769 (0.0%)
```

Copertura di `lineup_strength ≠ 1` per competizione (stagioni `2526`+`2627`):

```
fra.1  16/20     esp.1  12/23     ucl  12/117
ita.1   8/23     ger.1   6/18     eng.1  0/23
```

Tre letture, e la terza è quella che decide:

1. **L'esposizione è reale ma vale zero.** Il fattore muove le previsioni sul 62% delle gare di
   Serie A e non sposta il log loss di una cifra misurabile. Non aiuta e non danneggia.
2. **Non è retro-applicabile senza leakage.** `player_context` è uno snapshot unico con
   `as_of: 2026-08-23`, posteriore a **tutto** il dataset. La misura qui sopra è quindi
   "produzione con snapshot anacronistico" contro "backtest senza": dice quanto è grande
   l'esposizione, non se un `lineup_strength` correttamente datato servirebbe.
3. **È asimmetrico per lega, e l'asimmetria non è calcistica.** Una squadra francese riceve un
   aggiustamento nell'80% dei casi, una inglese **mai**. La selezione dipende da quali squadre
   l'enrichment è riuscito a risolvere, non da nulla che riguardi il calcio.

**Task 13 resta una modifica live mai misurata**, e `BRIEF-v2.md` §3.3 la elenca fra le cinque
correzioni "che cambiano le previsioni": vero in senso letterale, falso nel senso che conta.

### Q1 — Risolvere la divergenza produzione/misura
**Priorità assoluta. Nessun altro task prima di questo.**

La misura di §1.1 cambia la natura della decisione: non è più precauzione contro un rischio
ignoto, è una scelta su un fattore **misurato a zero e distribuito in modo asimmetrico per lega**.

- **(a) Spegnere `teamContext` in produzione.** Raccomandato. L'argomento non è più "non sappiamo":
  è che un perturbatore a valore misurato nullo, applicato all'80% delle squadre francesi e a
  nessuna inglese, è rumore con una struttura di bias. R10 dice di rimuoverlo o di annotarlo con
  la misura che lo respinge.
- **(b) Rendere `player_context` versionato nel tempo**, così che il backtest possa ricostruire lo
  stato alla data di ciascuna previsione. È l'unica strada che permetterebbe di sapere se un
  `lineup_strength` datato correttamente serve. Costo alto, e §1.1 non dà nessuna ragione per
  aspettarsi un guadagno: la coda di §5 ha priorità migliori.
- **(c) Tenerlo così com'è.** Sconsigliato, per il punto 3 di §1.1.

**Criterio di accettazione, qualunque sia la scelta**: un test che fallisce se `app.js` e
`backtest_model.mjs` passano insiemi di opzioni diversi a `predictFromMatches`. La divergenza deve
diventare impossibile da reintrodurre in silenzio, non solo corretta una volta. Oggi i default
numerici coincidono (`windowDays` 540, `halfLifeDays` 120): l'unica differenza è `teamContext`, e
niente impedisce che domani se ne aggiunga un'altra.

### 1.2 Incoerenza minore da sanare
Il commento in `model.js` sopra `refereeBiasFor()` documenta correttamente il leakage e conclude
che in produzione «non c'è nemmeno il guadagno». Il commento in `app.js:201-206` dice invece che
passare `refereeStats` ora significa che «il giorno in cui il campo sarà popolato l'effetto sarà
attivo senza altre modifiche» — senza menzionare che quell'effetto è stato misurato a
+0.0001 ± 0.0010. Chi legge `app.js` riceve un invito, chi legge `model.js` un avvertimento.
Allineare i due.

---

## 2. Emendamenti al protocollo

### R13 — Nessun aggregato precalcolato che veda il futuro
Ogni campo del payload usato dal modello deve essere **o** ricostruibile in avanti alla data della
previsione, **o** escluso sia dalla produzione sia dal backtest. Non esiste la terza opzione
"usato in produzione e ignorato in misura".

Confermato contaminante: `referee_stats`. Da verificare con la stessa procedura: `player_context`
(snapshot unico), `team_context.elo` (calcolato da `compute_elo` su tutte le partite concluse),
`coverage`, e qualunque aggregato di competizione.

### R14 — Produzione e misura devono ricevere gli stessi input
Una divergenza fra ciò che `app.js` passa e ciò che i backtest passano è un **bug**, non una
configurazione. Vale in entrambe le direzioni: un input in produzione che la misura non vede, e
un input nella misura che la produzione non ha.

### R15 — Un difetto di calibrazione misurato non è evidenza che correggerlo paghi
Nove tentativi su nove. Prima di aprire un task che nasce da una miscalibrazione osservata,
**pre-registrare la soglia di successo e la decisione in caso di fallimento** (la procedura di
P4, che ha funzionato).

### Correzione a P6 del prompt sessione 2 — errore mio
Avevo proposto due opzioni, **entrambe sbagliate**. `asymmetryShrinkLowQuality` è inerte sui
campionati (p05 = 0.995) ma **attivo su un terzo delle gare di coppa** (p05 = 0.597). Ritirarlo,
come suggerivo, avrebbe cambiato in silenzio le previsioni europee. Avevo guardato solo i segmenti
domestici e generalizzato. La verifica fatta in sessione 2 è quella corretta.

---

## 3. Il fatto che riorienta il progetto

Dal P3 della sessione 2, il singolo numero più informativo di tutto il lavoro:

```
fascia 01-03:   modello 1.0118    mercato 0.9539
media stagione: modello ~0.997    mercato  0.9759
```

**Nelle prime tre giornate il mercato prevede meglio della sua stessa media stagionale. Il modello
prevede peggio della sua.** Le due curve divergono, e il divario passa da ~+0.019 a fine stagione
a **+0.0579 (4.28σ)** a inizio.

Questo chiude l'ipotesi 1 di §5 del prompt sessione 2: le prime giornate **non** sono
intrinsecamente imprevedibili. Qualcuno le prevede meglio della media, quindi l'informazione
esiste ed è pubblica.

Combinato con i nove rifiuti, l'inferenza è stretta: **il deficit non è strutturale, è
informativo.** Il mercato in agosto sa cose che il modello non sa — chi è stato comprato e
venduto, chi è infortunato, chi ha cambiato allenatore, cosa hanno detto le amichevoli. Il
modello ha solo la stagione precedente, e i cinque tentativi di *fidarsene di meno* hanno
peggiorato tutti, perché è la cosa migliore che ha.

### La distinzione che rende Q3 diverso dai cinque rifiuti

I cinque meccanismi respinti dicevano tutti la stessa cosa: **"riduci la fiducia nel passato"**.
Nessuno ha testato: **"sposta la stima di una quantità nota, in una direzione nota, sulla base di
informazione nuova"**.

Non sono la stessa ipotesi in vesti diverse. Una squadra che ha comprato un attaccante da 20 gol
non è *più incerta*: è *più forte*, e di una quantità stimabile. Il segno è noto in anticipo, che
è il criterio che ha protetto gli unici interventi riusciti di due sessioni.

### Q3 — Delta di rosa direzionale
**Costo: alto · È l'unica pista con un bersaglio misurato (4.28σ) · Rischio: medio**

Idea: per ogni squadra all'inizio della stagione N, mappare la **produzione della stagione N−1 dei
giocatori presenti oggi in rosa**, e confrontarla con la produzione della rosa che ha effettivamente
giocato la N−1. La differenza è un delta direzionale di forza, non un fattore di incertezza.

Materiali già presenti nella pipeline:
- i roster (già interrogati da `enrich_competitions_players.py` in `squad_positions()`);
- le statistiche giocatore per partita (minuti, gol, assist, tiri) — ma **solo per la stagione
  corrente**: l'enrichment campiona solo le partite recenti. Serve estenderlo alla N−1.

Passi, con un cancello a ciascuno:
1. **Prima di scrivere codice**: verificare che il delta sia calcolabile per una fetta
   rappresentativa di squadre. Se la copertura roster × statistiche N−1 è sotto il 70% dei Big
   Five, il task si chiude qui e si risparmia tutto il resto.
2. **Direzione (R6), prima del log loss**: il delta deve correlare con lo scarto fra il rendimento
   effettivo della squadra nella stagione N e quello previsto dal solo Elo ereditato. Se non
   correla, il delta non misura ciò che si crede, e il log loss è irrilevante.
3. **Solo se 1 e 2 passano**: stima su `2324`+`2425`, validazione su `2526`, con soglia
   pre-registrata (R15).
4. **R13 obbligatorio**: il delta va calcolato con i dati disponibili **alla data della
   previsione**, non da uno snapshot. È lo stesso errore di `player_context`, e qui sarebbe fatale
   perché il segnale è concentrato proprio dove lo snapshot è più anacronistico.

### Q4 — Fattore di dispersione condiviso (test collaterale economico)
**Costo: basso · Distinto da tutto ciò che è stato respinto · Rischio: basso**

I pareggi sono sotto-previsti di 1.3pp e la coda bassa sovrastimata a −3.67σ. C1 ha testato `rho`
e l'holdout è risultato piatto — ma `rho` tocca solo le celle a punteggio basso (0-0, 1-0, 0-1,
1-1), quindi era la leva sbagliata per un difetto distribuito.

Meccanismo distinto: un **fattore moltiplicativo condiviso** applicato a entrambi i lambda della
stessa partita, che induce correlazione fra i due punteggi. A differenza della compressione
dell'asimmetria (respinta tre volte), non avvicina le due squadre: rende la *partita* più o meno
prolifica nel suo insieme, alzando `P(X=Y)` su tutta la matrice invece che solo in basso.

Un parametro, neutro a 1 (R1). `negativeBinomialPmf` esiste già in `model.js` per i mercati
giocatore, quindi parte della macchineria è presente.

**Avvertenza R15**: nasce da una miscalibrazione osservata, cioè dalla famiglia che ha fallito
nove volte su nove. Pre-registrare soglia e decisione prima di eseguire, e accettare il rifiuto
come esito probabile.

---

## 4. Il criterio di arresto — da decidere adesso, non dopo

Due sessioni, nove rifiuti, zero parametri in produzione, e il divario dal mercato è **cresciuto**
quando è stato misurato correttamente (da 0.017 stimato a 0.0214 misurato).

Questo va pre-registrato prima di conoscere l'esito di Q3, altrimenti la decisione verrà presa
guardando il risultato:

> **Se Q3 fallisce sull'holdout secondo la sua soglia pre-registrata, la fase di ottimizzazione
> dell'accuratezza si chiude.** Non si aprono ulteriori ipotesi strutturali sul log loss.

Non significa chiudere il progetto. Significa che il valore residuo è altrove, e le candidate
sono già identificate dal lavoro fatto:

- **Qualità dei dati**: è l'unica cosa che in due sessioni abbia mai cambiato qualcosa. Restano
  scoperti il possesso (14.9%) e le statistiche di coppa (quote 0%).
- **Mercati giocatore**: il mercato delle scommesse è molto più sottile lì che sull'1X2, quindi il
  confronto è meno impari. `estimatePlayerMarkets` esiste già e non è mai stato validato contro
  nulla.
- **Onestà dell'incertezza**: un modello che a inizio stagione dicesse *quanto* è incerto sarebbe
  più utile di uno che sbaglia con sicurezza — e la sessione 2 ha stabilito che `quality.score` è
  saturo sui campionati (p05 = 0.995), quindi oggi non lo dice.

---

## 5. Coda della sessione 3

| # | task | costo | precondizione |
|---|---|---|---|
| Q1 | Divergenza produzione/misura su `teamContext` | basso | nessuna — **prima di tutto** |
| Q2 | Audit leakage sistematico (R13) su tutti gli aggregati precalcolati | basso | Q1 |
| Q4 | Fattore di dispersione condiviso, con soglia pre-registrata | basso | Q2 |
| Q3 | Delta di rosa direzionale, con i quattro cancelli di §3 | alto | Q2, e il cancello 1 di §3 |
| — | Decisione di §4 secondo la regola pre-registrata | — | Q3 |

Q1 e Q2 sono correzioni di correttezza e vanno fatte comunque, qualunque sia la decisione di §4.
Q4 è economico e va fatto mentre Q3 è in preparazione. Q3 è la sola pista che punti al deficit
misurato più grande, e il suo cancello 1 può chiuderla in mezza giornata se i dati non ci sono.

---

## 6. Da non riaprire — lista aggiornata

Oltre a §4 del prompt sessione 2:

- **Scraping delle designazioni arbitrali.** Chiuso da C2: l'effetto era interamente leakage
  (+0.0050 → +0.0001 in walk-forward). `referee_stats` è inutilizzabile in qualsiasi backtest
  nella forma attuale.
- **Calibrazione dedicata alle coppe.** Testata correttamente: −0.0004 ± 0.0019, e −0.0028 ±
  0.0012 con rho teorico. Il miglioramento visto sull'holdout era un artefatto.
- **`rho` come correzione al deficit di pareggi.** Train monotono verso −0.10, holdout piatto
  (+0.0002 ovunque), e a −0.10 il bias si ribalta.
- **Ritirare `asymmetryShrinkLowQuality`.** È attivo su un terzo delle gare di coppa.
- **Ipotesi 1 di §5 sessione 2** (le prime giornate sono intrinsecamente imprevedibili). Il
  mercato le prevede meglio della sua media: falsa.
- **Ipotesi §9.4 della sessione 2** (sotto-sicurezza sui favoriti forti). Ritirata dall'autore:
  le fasce estreme stanno a 0.66σ contro gli esiti. Era stata dedotta dal confronto col mercato
  invece che dagli esiti.
