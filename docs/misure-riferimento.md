# Misure di riferimento

**Fonte unica dei numeri di questo progetto.** Il brief v1 li teneva inline e sono diventati stali
in una sola sessione; `BRIEF-v2.md` è la sintesi che si legge per prima e rimanda qui.

| | |
|---|---|
| dataset corrente | `data/matches.json`, **8403 gare**, generato 2026-08-24, corretto 2026-08-25 (alias squadre, backfill xG, `lineup_strength`) |
| finestra di stima (R7) | stagioni `2324` + `2425`, fino al **2025-05-31** |
| holdout (R7) | stagione `2526` e parte di `2627`, dal **2025-07-08**. Mai usato per stimare nulla |
| backtest di riferimento | `npm run backtest -- --competition ita.1` -> **0.9886 / RPS 0.1954 / acc 0.527** |
| distanza dal mercato | **+0.0214 ± 0.0028** appaiato, su 3657 gare con quote |

Le sezioni 0-8 sono della sessione 1 e riguardano il dataset **prima** e **dopo** la correzione
degli alias; le sezioni 9-16 sono della sessione 2 e sono tutte misurate sul dataset corretto. Ogni
sezione dichiara la propria numerosità.

---


Il brief (`BRIEF-claude-code.md`, Task 0.3) prescrive: se le misure di §2 non si riproducono, il
dataset è cambiato e i riferimenti vanno ricalcolati **prima di procedere**. Task 1 ha cambiato il
dataset di proposito (identità di club ricomposte, copertura xG da 34% a ~100% in due leghe), quindi
i numeri del brief sono ora storici. Questo file è il riferimento vivo.

Comandi che li riproducono, tutti deterministici:

```bash
npm run backtest -- --competition ita.1
node scripts/diag_season_phase.mjs 2024-08-01                 # e --by league / --by xgcoverage
node scripts/diag_paired_ab.mjs ita.1 2024-08-01
node scripts/diagnose_calibration.mjs --by league
```

---

## 0. Verifica che le misure del brief erano riproducibili

Prima di modificare qualsiasi cosa, i riferimenti del brief sono stati riprodotti **esattamente**
sul dataset del 24/08/2026. Se non lo fossero stati, tutto il resto sarebbe stato non confrontabile.

| misura | brief | riprodotto |
|---|---|---|
| §1.3 backtest `ita.1` | logLoss 0.9878, RPS 0.1953, acc 0.526, 1000 gare | identico |
| §2.1 fasce 01-03…20+ | n 415/345/388/865/1689 · logLoss 1.018/0.973/0.980/0.990/0.997 | identico |
| §2.1 `quality.score` | 0.902 → 0.976 | identico |
| §2.4 appaiato `newcomerEloDiscount: -65` | base 0.9856, variante 0.9854, diff 0.0002 ± 0.0002, 87/768 | identico |
| §2.4 errore std non appaiato | 0.0154 | identico |
| §2.6 copertura xG | ita 99/90/90 · eng 77/78/78 · fra 77/76/85 · esp 46/35/36 · ger 34/34/23 | identico |

---

## 1. Dopo Task 1 — dataset 8403 gare (era 8646)

La differenza di 243 righe non è perdita di dati: sono le righe duplicate rimosse, cioè la stessa
partita reale presente due volte perché due fonti la scrivevano con nomi di squadra diversi.

### 1.1 Backtest `ita.1` (§1.3)

```
logLoss 0.9883 · RPS 0.1954 · Brier 0.5914 · accuracy 0.525 · 1000 gare (2023-12-11 → 2026-08-23)
```

Serie A si muove pochissimo, ed è atteso: era già al 90% di copertura xG. L'effetto di Task 1 è in
Bundesliga e LaLiga.

### 1.2 Fasce di stagione (§2.1), 3544 gare dal 2024-08-01

```
fascia   |    n | logLoss | acc   | quality | P(1) oss    | P(2) oss    | xgCov
01-03    |  330 |  1.004  | 0.488 |  0.947  | .419 .442   | .335 .306   | 0.951
04-06    |  288 |  0.982  | 0.497 |  0.998  | .432 .413   | .324 .306   | 0.997
07-10    |  383 |  0.984  | 0.509 |  0.998  | .426 .475   | .331 .266   | 0.997
11-19    |  871 |  0.989  | 0.537 |  1.000  | .435 .423   | .324 .326   | 0.998
20+      | 1672 |  0.994  | 0.528 |  1.000  | .436 .424   | .323 .330   | 0.997
```

Tre letture, tutte rilevanti per i task successivi:

1. **Il conteggio delle fasce era esso stesso falsato.** 415 gare nella fascia 01-03 sono diventate
   330: le righe duplicate gonfiavano il contatore di partite per squadra, quindi la "giornata
   effettiva" era sbagliata. Anche la diagnostica di §2.1 misurava in parte l'artefatto.
2. **Il divario di inizio stagione si è dimezzato ma non è sparito**: 01-03 contro 20+ passa da
   0.021 a 0.010 di log loss. Resta il segmento peggiore.
3. **`quality.score` è peggiorato come strumento.** Sale da 0.902 a 0.947 nella fascia 01-03 e da
   0.976 a 1.000 nella 20+: lo spread si comprime da 0.074 a 0.053. La componente `xgCoverage`
   contribuiva parte della variabilità, e ora è satura a ~1 ovunque. **Task 2 è quindi più
   necessario di prima, non meno**: il meccanismo di prudenza è ancora più inerte.

### 1.3 Per lega, 3544 gare dal 2024-08-01

```
lega    |    n | logLoss | acc   | quality | xgCov
eng.1   |  769 |  1.001  | 0.524 |  0.995  | 0.995
esp.1   |  774 |  0.981  | 0.539 |  0.994  | 0.993
fra.1   |  621 |  0.994  | 0.519 |  0.994  | 0.987
ger.1   |  612 |  1.000  | 0.502 |  0.996  | 0.996
ita.1   |  768 |  0.986  | 0.521 |  0.995  | 0.994
TOTALE  | 3544 |  0.992  | 0.522 |
```

### 1.4 Appaiato `newcomerEloDiscount: -65` (§2.4)

```
log loss base        : 0.9863      (era 0.9856)
log loss variante    : 0.9862
differenza appaiata  : 0.0002 ± 0.0002    IC 95% [-0.0001, 0.0005]
gare toccate         : 87/768      (invariato)
```

**Il gancio delle neopromosse resta inerte anche dopo Task 1**: 87 gare su 768, cioè l'11%, e quasi
tutte nella fascia 20+ invece che a inizio stagione. La premessa di Task 4 regge intatta.

---

## 2. Effetto misurato di Task 1 — confronto appaiato fra dataset

`scripts/diag_dataset_ab.mjs` appaia le stesse partite nelle due versioni dei dati **per `id`**, non
per nomi: la canonicalizzazione ha cambiato proprio i nomi, e agganciare per nome avrebbe misurato
zero differenze esattamente sulle partite toccate.

```
3544 gare appaiate, dal 2024-08-01
log loss VECCHIO : 0.9928
log loss NUOVO   : 0.9920
differenza appaiata : 0.0008 ± 0.0008    IC 95% [-0.0007, 0.0024]

per lega:
  ger.1  612 |  +0.0033 ± 0.0026     (copertura xG 34% -> 100%)
  esp.1  774 |  +0.0015 ± 0.0022     (36% -> 100%)
  eng.1  769 |  +0.0007 ± 0.0014     (78% -> 100%)
  fra.1  621 |  -0.0003 ± 0.0015     (76% -> 100%)
  ita.1  768 |  -0.0007 ± 0.0009     (90% -> 100%)
```

**Lettura onesta**: in aggregato la differenza **non è distinguibile da zero**. L'ordinamento per
lega però segue la dimensione del cambiamento nei dati — le due leghe che passano da un terzo a
copertura piena sono le due che guadagnano di più, e Serie A e Ligue 1, che cambiavano poco, non
guadagnano nulla. La direzione è quella prevista (R6); l'entità, a questa numerosità, non lo è.

Task 1 va quindi giudicato per ciò che è: **una correzione dell'input, non un miglioramento del
modello**. Il suo valore vero è che rende misurabili i task successivi — prima, per due quinti del
dataset, ogni confronto poggiava su un proxy dei tiri travestito da xG.

### 2.1 Bias del proxy, misurato direttamente

Sulle 1767 partite passate da proxy a xG reale:

```
xG reale medio    casa 1.754  trasferta 1.345   asimmetria 0.409
proxy tiri medio  casa 1.478  trasferta 1.218   asimmetria 0.260
bias del proxy    casa -0.276 trasferta -0.127  -> asimmetria compressa di 0.149
```

Il fallback `0.16 + 0.026·tiri + 0.19·tiriInPorta` non sbaglia solo in modulo: sbaglia **di più in
casa che in trasferta**, quindi comprimeva sistematicamente il vantaggio campo misurato in xG nelle
leghe dove veniva usato. È un fatto sui dati, verificato. Non è però la spiegazione del valore di
`venueTilt`: vedi sotto.

---

## 3. Ricalibrazione (R4) — eseguita e **respinta sull'holdout**

`npm run fit:calibration -- --train-until 2025-05-31` rispetta R7: stima su `2324`+`2425`, non tocca
mai `2526`.

| parametro | in produzione | ristimato | Δ |
|---|---|---|---|
| `asymmetryShrink` | 0.7100 | 0.7111 | +0.0011 |
| `asymmetryShrinkLowQuality` | 0.3000 | 0.0000 | −0.3000 |
| `levelShrink` | 0.4500 | 0.3926 | −0.0574 |
| `levelShift` | −0.0200 | −0.0195 | +0.0005 |
| `venueTilt` | 0.0180 | 0.0023 | −0.0157 |
| `rho` | −0.0400 | +0.0132 | +0.0532 |

Confronto appaiato sull'holdout `2526` (1792 gare, tutte le leghe):

```
variante            diff appaiata     IC 95%
refit completo        -0.0020 ± 0.0009   [-0.0038, -0.0004]
refit prudente        -0.0008 ± 0.0005   [-0.0018, +0.0002]
solo venueTilt        -0.0009 ± 0.0005   [-0.0019, +0.0001]
```

**Tutte e tre peggiorano.** Il refit migliora sulla finestra di stima e degrada su quella
successiva: è overfitting della ricerca di calibrazione, ed è esattamente il caso che R7 esiste per
intercettare. `DEFAULT_CALIBRATION` resta invariata.

Due conseguenze da tenere a mente nei task successivi:

- il refit **non va adottato solo perché è un refit**. Va sempre passato dall'holdout;
- l'inferenza intuitiva "il proxy comprimeva l'asimmetria casa, quindi `venueTilt = 0.018` la stava
  compensando, quindi ora deve scendere" **è smentita dai dati**: dopo la correzione dell'input,
  0.018 resta il valore migliore sull'holdout, e abbassarlo costa 0.0009. La misura del bias del
  proxy (§2.1) resta vera; la catena causale verso `venueTilt` no. Va tenuta come promemoria per
  Task 5, che su questo terreno lavora.

---

## 4. Task 2 — freschezza di stagione in `dataQuality`: **respinto sui dati**

Meccanismo implementato (`quality.seasonFreshness`, iperparametro `seasonQualityWeight`), direzione
verificata, neutralità R1 bit per bit a peso 0, poi stimato e respinto.

### 4.1 Il meccanismo funziona

Freschezza misurata su 3544 gare, con la stagione corrente risolta correttamente su tutte:

```
fascia   |    n | seasonFreshness | quality(w=0)
01-03    |  330 |          0.228  |       0.947
04-06    |  288 |          0.625  |       0.998
07-10    |  383 |          0.810  |       0.998
11-19    |  871 |          0.964  |       1.000
20+      | 1672 |          1.000  |       1.000
```

Con `w ≥ 0.483` lo score della fascia 01-03 scende sotto 0.6, cioè il criterio di direzione del
brief è raggiungibile. Il criterio di **esito** però non lo è.

### 4.2 La stima lo respinge, su due finestre indipendenti

Confronto appaiato, cinque pesi di griglia. Train = `2324`+`2425` (2779 gare, fino al 2025-05-31);
holdout = `2526` (1792 gare, mai usato per stimare — R7).

```
peso | train aggr. | holdout aggr. | holdout 01-03      | holdout 04-06
0.15 |    -0.0001  |     -0.0002   | -0.0006 ± 0.0018   | -0.0011 ± 0.0010
0.30 |    -0.0003  |     -0.0004   | -0.0018 ± 0.0037   | -0.0025 ± 0.0020
0.45 |    -0.0005  |     -0.0007   | -0.0036 ± 0.0055   | -0.0040 ± 0.0030
0.60 |    -0.0008  |     -0.0011   | -0.0060 ± 0.0073   | -0.0056 ± 0.0040
0.75 |    -0.0011  |     -0.0016   | -0.0090 ± 0.0092   | -0.0075 ± 0.0050
```

Nessun peso migliora nulla. Il degrado è monotono e colpisce **esattamente i segmenti che la
modifica doveva aiutare**. L'ottimo su entrambe le finestre è `w = 0`.

### 4.3 Cosa insegna, al di là del parametro

§2.1 del brief diceva due cose. La prima — "il meccanismo di prudenza è calibrato ed è inerte" — è
vera e resta vera. La seconda, implicita, era che accenderlo avrebbe aiutato: **è falsa**.

Comprimere l'asimmetria avvicina le probabilità alle frequenze di lega. Se farlo di più a inizio
stagione peggiora, allora il rapporto di forza che il modello eredita dalla stagione precedente
**contiene segnale vero**, e scontarlo in blocco butta via informazione insieme al rumore. Le prime
giornate non sono mal calibrate: sono intrinsecamente più difficili.

Conseguenza diretta per Task 3, che va letta prima di iniziarlo: la regressione dell'Elo al confine
di stagione agisce sullo **stesso bersaglio** (ridurre il differenziale di forza a inizio stagione)
ma in modo **mirato** — sconta la stima ereditata invece di comprimere tutta l'asimmetria, segnale
della stagione corrente incluso. Questo risultato negativo alza la barra per Task 3 senza deciderlo:
se anche lo shrinkage mirato peggiora, l'ipotesi "il modello è troppo sicuro a inizio stagione" è
morta; se invece migliora, la differenza fra i due esiti dice esattamente *quale* parte del segnale
andava scontata.

---

## 5. Task 3 — regressione dell'Elo al confine di stagione: **respinto sui dati**

Meccanismo implementato e attivo (1792/1792 gare toccate sull'holdout — non è il caso di
`newcomerEloDiscount`, che ne tocca 87 su 768), direzione verificata su fixture sintetico e su dati
reali, neutralità R1 bit per bit a `k = 1`, poi stimato e respinto.

### 5.1 Il meccanismo fa quello che deve

Elo di apertura della Serie A 2627, media di lega 1550:

```
squadra     |   k=1.0 |   k=0.7 |   k=0.5
Inter       |  1699.3 |  1652.6 |  1621.9
Juventus    |  1627.8 |  1608.0 |  1592.0
Napoli      |  1613.1 |  1596.2 |  1582.8
...
Lecce       |  1428.4 |  1481.5 |  1507.3
Monza       |  1409.5 |  1458.4 |  1487.7
```

Ogni squadra apre **strettamente fra la media di lega e il valore non regredito**, chi sta sopra
scende e chi sta sotto risale, e il valore cambia in modo monotono con `k`. Sull'Inter la
regressione totale a `k = 0.7` vale il 31%, dentro l'intervallo 20-35% della letteratura (è la
composizione con il decadimento per inattività, che al confine estivo scatta comunque).

Un caso che il brief non prevedeva ed è quello che conta di più: **alla prima giornata assoluta di
una stagione il dataset non contiene ancora nessuna gara di quella stagione**, quindi `applyMatch()`
non ha ancora visto nessun confine. Applicare la regressione solo lì l'avrebbe resa inerte proprio
nel momento in cui serve — lo stesso modo in cui `newcomerEloDiscount` è rimasto inerte. Va quindi
applicata **anche in avanti**, dentro `stateMetrics()`, sulla stessa dualità che il codice ha già fra
`decayInactiveElo()` ed `eloRetention`.

### 5.2 La stima lo respinge, su due finestre indipendenti

```
        train (2779 gare)            holdout 2526 (1792 gare)
  k     aggr.    01-03      04-06    aggr.    01-03              04-06
0.90  -0.0001  +0.0001    -0.0010  -0.0005  -0.0012 ± 0.0008   -0.0022 ± 0.0007
0.80  -0.0002  +0.0002    -0.0019  -0.0009  -0.0024 ± 0.0015   -0.0043 ± 0.0013
0.70  -0.0003  +0.0002    -0.0030  -0.0014  -0.0037 ± 0.0022   -0.0063 ± 0.0020
0.60  -0.0004  +0.0002    -0.0040  -0.0019  -0.0050 ± 0.0029   -0.0084 ± 0.0026
0.50  -0.0005  +0.0001    -0.0051  -0.0025  -0.0064 ± 0.0036   -0.0104 ± 0.0031
```

Il criterio di accettazione chiedeva un **guadagno appaiato sul segmento 01-06 di almeno due errori
standard**. Sull'holdout il segmento 04-06 perde circa **tre** errori standard a `k = 0.70`, e il
degrado è monotono in `k`. Il valore ottimo su entrambe le finestre è `k = 1`, cioè nessuna
regressione. Il `k ≈ 0.70` atteso dalla letteratura non regge su questi dati.

### 5.3 Due rifiuti indipendenti della stessa ipotesi

Task 2 e Task 3 attaccano lo stesso bersaglio da due lati diversi — comprimere l'asimmetria in
blocco il primo, scontare la stima di forza ereditata il secondo — e **peggiorano entrambi, in modo
monotono, proprio sui segmenti di inizio stagione**. Presi insieme non sono due mancati
miglioramenti: sono una risposta.

L'ipotesi "il modello è troppo sicuro a inizio stagione" è **falsa su questi dati**. La diagnosi
meccanica del brief resta vera (il modello non sa che la stagione è cambiata; l'Elo regredisce del
5.4% invece che del 20-35%), ma la conclusione che ne discendeva no: il rapporto di forza ereditato
dalla stagione precedente **è informativo**, e scontarlo butta via segnale insieme al rumore.

Ipotesi sul perché, da verificare e non da dare per acquisita: gli esponenti di attacco e difesa
sommano a 1.00 ciascuno e i loro termini (`gf5`, `xgFor5`, `sot5`, `shots5`, half-life 70 giorni)
**portano anch'essi il livello della stagione scorsa, a piena forza** — alla 5ª giornata il 41% di
quel segnale viene ancora da lì (§2.2 del brief). Scontare il solo Elo non riduce il differenziale
di forza: lo rende **incoerente**, perché de-pesa la stima di forza mentre gli altri quattro fattori
continuano ad affermare il livello dell'anno prima. Se questa lettura è giusta, il rimedio non è un
`k` sull'Elo ma un allineamento delle costanti di tempo — che è il difetto che §2.2 chiama
"incoerenza dei tempi" e che nessun task della coda affronta direttamente.

`seasonEloRegression` resta quindi a 1 in produzione, con il meccanismo coperto da test e
riattivabile cambiando un solo numero.

---

## 6. Task 4 — neopromosse: **bug corretto, prior positivo ma non significativo fuori campione**

Va letto come due cose separate, perché lo sono.

### 6.1 La definizione era sbagliata, e ora non lo è

`newcomerTeams()` chiamava "nuova" una squadra la cui prima gara nella finestra coincide con la prima
gara nell'**intero dataset**. Il Frosinone era in Serie A nel 2324, quindi è nel dataset, quindi non
è mai stato riconosciuto — qualunque valore avesse `newcomerEloDiscount`.

`competitionNewcomers()` usa la definizione corretta ("non era in QUESTA competizione nella stagione
PRECEDENTE") e distingue tre casi:

```
ita.1 2627 -> Frosinone (2 stagioni fuori), Monza (1), Venezia (1)
ita.1 2526 -> Cremonese (mai vista), Pisa (mai vista), Sassuolo (2)
esp.1 2627 -> Deportivo La Coruna, Racing Santander, Málaga (tutte mai viste)
ger.1 2526 -> FC Koln (2), Hamburg (mai vista)
```

C'era una seconda metà del difetto che una definizione corretta da sola non chiudeva: il gancio si
consultava solo al **cold start** (`!states.has(team)`). Una squadra rientrata dopo un anno ha già
uno stato — con l'Elo di due stagioni fa — quindi non sarebbe stata intercettata comunque. Il
riconoscimento va applicato al **confine di stagione**, e anche in avanti dentro `stateMetrics()`
per la prima giornata, esattamente come per Task 3.

Criterio del brief sulle gare toccate: **da 87/768 a 751/768** in Serie A. Il coinvolgimento
*diretto* (almeno una neopromossa in campo) è 219/768 = 28.5%; il resto è propagazione, perché
cambiare l'Elo di una squadra cambia i delta di ogni partita giocata contro di lei.

### 6.2 Il prior stimato dai dati vale −128 Elo, non −65

Sulle neopromosse di `2425` (14 squadre, 5 leghe, 512 gare-squadra — `2324` non ha una stagione
precedente nel dataset, `2526` è holdout per R7):

```
punteggio Elo medio delle neopromosse (1 vittoria, 0.5 pareggio)
  eng.1  S=0.2061  ->  -234 Elo        stime con shrinkage verso il comune:
  esp.1  S=0.3246  ->  -127 Elo          eng.1 -151   esp.1 -128   ita.1 -117
  ita.1  S=0.3904  ->   -77 Elo          ger.1 -129   fra.1 -118
  ger.1  S=0.3162  ->  -134 Elo
  fra.1  S=0.3873  ->   -80 Elo        comune: S=0.3242 -> -128 Elo
```

Tutte e 14 le squadre sotto la media, senza eccezioni. Dopo lo shrinkage (peso di lega 0.15-0.22,
come impone il brief con 2-3 osservazioni per lega) le cinque stime stanno in 34 punti: il valore
comune −128 le riassume, e stimarle indipendentemente sarebbe overfitting garantito.

**Il default in produzione è 1500 per una squadra al debutto. Questa misura dice che è sbagliato di
128 punti Elo.** Non è quindi una scelta fra "aggiungere un parametro" e "non aggiungerlo", ma fra
due numeri per una squadra di cui non si sa nulla.

### 6.3 Effetto misurato

```
variante                          ita.1 (768)        train (2779)        holdout 2526 (1792)
brief65    (-65, ancora 1500)   +0.0016 [.0002,.0031]  +0.0010 [.0004,.0016]  +0.0004 [-.0002,.0011]
prior128   (-128, media lega)   +0.0016 [.0002,.0031]  +0.0011 [.0003,.0019]  +0.0005 [-.0003,.0013]
prior128 + ritenzione 0.7/0.5   invariato              invariato              +0.0005 / +0.0006
solo_stale (solo ritenzione)    -0.0012 [-.0022,-.0002] -0.0010 [-.0015,-.0006] -0.0007 [-.0013,-.0001]
```

Segmento 01-10, il criterio del brief:

```
            01-03              04-06              07-10
train    +0.0099 ± 0.0029   +0.0014 ± 0.0032   -0.0006 ± 0.0024   -> 01-10 combinato +0.0032
holdout  +0.0014 ± 0.0015   +0.0002 ± 0.0019   +0.0021 ± 0.0018   -> 01-10 combinato +0.0013
```

**Sul training il criterio è superato con margine** (la fascia 01-03 da sola vale 3.4 errori
standard). **Sull'holdout il guadagno resta positivo ma scende a ~1.3 errori standard**, sotto la
soglia di 2 che il brief richiede.

### 6.4 Decisione

- La **correzione della definizione** entra in produzione: è un bug, ed è neutra a parametri neutri.
- Il **prior resta spento** (`newcomerEloDiscount: 0`), perché il cancello §6 chiede significatività
  fuori campione e sull'holdout non c'è. Per accenderlo con il valore stimato:
  `hyperparameters: { newcomerEloDiscount: -128, newcomerEloAnchor: 1 }`.
- La **ritenzione resta a 1**: è l'unico dei tre parametri il cui effetto è *negativo* e
  significativo su entrambe le finestre. È la terza conferma indipendente — dopo Task 2 e Task 3 —
  che scontare la forza ereditata peggiora le previsioni.

Questa è l'unica voce della coda in cui l'evidenza punta nella stessa direzione ovunque (positiva su
Serie A, su train, su holdout e in 9 segmenti su 10) e manca solo la significatività fuori campione.
Vale la pena rimisurarla quando `2627` sarà completa: con una terza stagione di neopromosse il
campione di stima raddoppia.

---

## 7. Task 5 — vantaggio campo: **chiuso senza modifiche, ed è un risultato**

Il brief pone la condizione giusta prima di toccare il codice: parte dell'effetto è già catturata
dalle baseline `league.homeGoals`/`awayGoals`, che `weightedCompetitionAverages` calcola **per
competizione**. La domanda non è se le leghe differiscano — ovviamente sì — ma quanto ne resti fuori.
Tre misure (`scripts/diag_home_advantage.mjs`), e tutte e tre dicono: niente.

### 7.1 Il trend non esiste

§2.7 cita il calo del tasso di vittorie casalinghe in Serie A (0.418 → 0.397 → 0.389) come possibile
deriva, e chiede esplicitamente di misurarlo su tutte e cinque le leghe prima di trattarlo come tale.

```
lega   | 2324  | 2425  | 2526  | delta 2324 -> 2526
eng.1  | 0.461 | 0.408 | 0.426 |  -3.4pp
esp.1  | 0.439 | 0.445 | 0.489 |  +5.0pp
fra.1  | 0.392 | 0.467 | 0.461 |  +6.9pp
ger.1  | 0.438 | 0.386 | 0.438 |   0.0pp
ita.1  | 0.418 | 0.397 | 0.389 |  -2.9pp
```

**Due leghe su cinque scendono**, e LaLiga e Ligue 1 salgono più di quanto la Serie A scenda. Sotto
l'ipotesi "nessun trend" il segno è una moneta, e vedere almeno 2 cali su 5 ha probabilità **81%**.
Il calo della Serie A è una lega su cinque: esattamente ciò che il rumore produce.

### 7.2 Il residuo per lega è dentro il rumore

Scarto fra P(1) previsto e osservato, 3544 gare dal 2024-08-01:

```
lega   |    n | P(1) prev | P(1) oss | residuo | err.std | sigma
eng.1  |  769 |     0.430 |    0.421 | -0.0086 |  0.0167 | -0.51
esp.1  |  774 |     0.448 |    0.466 | +0.0188 |  0.0169 | +1.11
fra.1  |  621 |     0.444 |    0.461 | +0.0169 |  0.0186 | +0.91
ger.1  |  612 |     0.438 |    0.412 | -0.0264 |  0.0187 | -1.41
ita.1  |  768 |     0.407 |    0.392 | -0.0152 |  0.0166 | -0.92

chi-quadro congiunto, 5 gradi di libertà: 5.18   (soglia p=0.05: 11.07)
```

Il valore atteso di un chi-quadro con 5 gradi di libertà **è 5**. Il modello è già calibrato per
lega: i 5.4pp di spread grezzo di §2.7 sono interamente assorbiti dalle baseline per competizione.

### 7.3 Il residuo per squadra c'è, ma non è vantaggio campo

Questo è il punto in cui era facile sbagliare. Il residuo casalingo per squadra mostra dispersione
oltre il caso: chi-quadro 136.9 su 110 squadre, cioè **1.8 sigma** sopra l'atteso. Preso per buono,
avrebbe giustificato un termine per squadra.

Ma una squadra sistematicamente sottovalutata mostra un residuo positivo **in casa e anche in
trasferta**: la dispersione del solo residuo casalingo non distingue "questa squadra ha un vantaggio
campo speciale" da "questa squadra è più forte di quanto il modello creda". La quantità specifica
del venue è la **differenza** fra i due residui.

```
chi-quadro sulla differenza (casa - trasferta), 110 squadre: 112.1   attesi 110   scarto +0.14 sigma
```

**Zero.** La dispersione del residuo casalingo era interamente forza mal valutata. Il Wolfsburg, che
sul solo residuo casalingo appariva a −2.87 sigma, sulla differenza resta a −3.25 sigma su 110
squadre osservate: con quel numero di confronti, il minimo atteso per puro caso è circa quello.

### 7.4 Conclusione

Nessuna modifica al modello. Un vantaggio campo per lega stimerebbe rumore (§7.2), uno per squadra
stimerebbe rumore diverso (§7.3), e la costante non va inseguita nel tempo perché il tempo non la
sta muovendo (§7.1). Il criterio del brief — "se il residuo per lega è dentro il rumore, questo task
si chiude senza modifiche ed è comunque un risultato" — è soddisfatto nella sua seconda branca.

Resta il valore collaterale, che non è piccolo: `venueTilt = 0.018` era sospettato di compensare un
artefatto (§2.1 di questo documento). Ora si sa che non lo compensa, che non serve differenziarlo
per lega, e che la sua stabilità su tre split non era fortuna.

---

## 8. Task 6-9 e 14 — batteria appaiata, un parametro per variante

Tutte e cinque le voci sono state implementate **neutre di default** e misurate insieme, ma con una
variante per parametro: R8 vieta di stimare più parametri contemporaneamente, non di eseguire più
test indipendenti nello stesso processo.

Train = `2324`+`2425` (2779 gare, fino al 2025-05-31). Holdout = `2526` (1792 gare, mai usato per
stimare).

```
variante                          train                      holdout 2526              tocc.
t6_eu_away_94    (trasferta UEFA) +0.0001 [-.0002,+.0005]   +0.0001 [-.0004,+.0007]   198/1792
t6_congest_97    (3 gare in 8 gg) -0.0001 [-.0004,+.0002]   -0.0002 [-.0006,+.0001]   475/1792
t7_forma_res_50  (forma-residuo)  -0.0003 [-.0009,+.0003]   -0.0011 [-.0019,-.0001]  1792/1792
t7_forma_res_100 (solo residuo)   -0.0008 [-.0020,+.0004]   -0.0025 [-.0042,-.0007]  1792/1792
t8_overperf_15   (gol/xG ^-0.15)  -0.0001 [-.0009,+.0007]   +0.0009 [-.0001,+.0018]  1792/1792
t8_overperf_30   (gol/xG ^-0.30)  -0.0008 [-.0024,+.0008]   +0.0012 [-.0008,+.0032]  1792/1792
t9_rossi_50      (peso rossi 0.5) +0.0009 [-.0004,+.0023]   +0.0018 [+.0000,+.0035]  1786/1792
```

### 8.1 Task 6 — impegno europeo: direzione giusta, ampiezza nulla

La misura di direzione (R6), fatta **prima** di guardare il log loss su 7088 osservazioni
squadra-partita, è quella che il task chiedeva:

```
segmento                          |    n | residuo gol      | residuo vittoria
nessuna coppa negli 8 giorni      | 6203 | -0.000 ± 0.015   | -0.0059 ± 0.0057
coppa 2-5 giorni prima            |  792 | -0.020 ± 0.046   | -0.0122 ± 0.0166
  di cui in TRASFERTA             |  399 | -0.050 ± 0.065   | -0.0449 ± 0.0234
  di cui in casa                  |  393 | +0.010 ± 0.065   | +0.0210 ± 0.0236
```

Negativa su gol e vittorie, come impone il criterio, e concentrata nel caso che il brief indicava —
la **trasferta** europea, −4.5pp di probabilità di vittoria (−1.9 sigma), contro +2.1pp per la gara
europea in casa. I due casi hanno segno opposto, ed è per questo che sono due parametri.

Emerge anche un difetto che il brief non nominava: per una previsione domestica
`predictFromMatches()` filtra le coppe via da `chronological`, quindi la gara di mercoledì non è
priva di etichetta — **è invisibile**. Il riposo che il modello crede di vedere supera quello vero
di **5.1 giorni** in media per chi ha giocato in coppa, 6.0 dopo una trasferta. Non era un fattore
mancante: era un input sbagliato, e sbagliato in modo silenzioso.

Nel log loss però l'effetto sparisce: +0.0001 su entrambe le finestre, IC che include lo zero,
198 gare toccate su 1792. **Resta neutro.** Il guadagno atteso dal brief era "basso" e la misura lo
conferma: l'effetto esiste sul campo ma è troppo raro e troppo piccolo per spostare il log loss.

Il caso cumulativo (`thirdInEight`) è **negativo** su entrambe le finestre: chiuso.

### 8.2 Task 7 — forma ortogonale: il criterio di direzione è raggiunto, l'esito è peggiore

La ridefinizione funziona esattamente come doveva. Su 590 gare di Serie A:

```
termine                      sd      corr con EloDiff   corr con l'esito
momentum attuale (punti)    0.890         0.743               0.323
residuo sul risultato       0.211         0.311               0.126
residuo sugli xG            0.093         0.139               0.120
blend 50/50                 0.177         0.267               0.146
```

Collinearità con l'Elo da **0.743 a 0.267**, sotto la soglia di 0.30 richiesta. E il blend è la
scelta giusta e non un compromesso: è l'unica combinazione che scende sotto soglia **e** ha
correlazione con l'esito più alta di entrambe le componenti prese da sole.

**Eppure il log loss peggiora, in modo monotono nel peso e significativamente sull'holdout**
(−0.0011 a peso 0.5, −0.0025 a peso 1.0, IC che escludono lo zero).

La riga che spiega tutto è la terza colonna: il momentum in punti correla con l'esito **0.323**, il
blend ortogonale **0.146**. Rendere la forma ortogonale all'Elo le ha tolto più segnale di quanta
ridondanza le abbia tolto. §2.5 chiamava il termine "forza contata due volte": la misura dice che
quella seconda copia **non è una copia** — è lo stesso livello misurato con un rumore diverso, e
mediare due misure rumorose della stessa quantità è esattamente ciò che un modello dovrebbe fare.

Con Task 2 e Task 3 fa **tre meccanismi indipendenti** che riducono il peso della forza ereditata e
peggiorano tutti. Non è più una serie di risultati negativi: è una proprietà del modello.

### 8.3 Task 8 — sovra-rendimento sugli xG: segno instabile

Train negativo (−0.0001 e −0.0008), holdout positivo (+0.0009 e +0.0012), IC che includono lo zero
su tutte e quattro le misure. **Il segno si inverte fra le due finestre**, che è il modo più chiaro
in cui un effetto dice di non esistere.

Il brief chiedeva di valutarlo solo dove gli xG sono reali: dopo Task 1 la copertura è ~100% in
tutte e cinque le leghe, quindi questa condizione è soddisfatta e il risultato non è attribuibile al
proxy dei tiri. L'ipotesi di regressione alla media sul rapporto gol/xG **non regge su questi
dati**: chiuso senza merge, come il brief stesso prescrive per questo esito.

### 8.4 Task 9 — rossi: l'unica voce che migliora su entrambe le finestre

```
             train              holdout
aggregato  +0.0009            +0.0018 [+0.0000, +0.0035]
01-03      -0.0043 ± 0.0029   +0.0010 ± 0.0030
04-06      +0.0039 ± 0.0032   +0.0026 ± 0.0037
07-10      +0.0006 ± 0.0031   +0.0040 ± 0.0030
11-19      +0.0024 ± 0.0015   +0.0021 ± 0.0018
20+        +0.0005 ± 0.0009   +0.0011 ± 0.0012
```

Il criterio del brief per questo task è esplicitamente più basso degli altri — "nessun peggioramento
su nessun segmento", non "migliora significativamente", perché il guadagno atteso era piccolo.
**Sull'holdout tutti e cinque i segmenti migliorano.** Su train quattro su cinque, e il quinto
(01-03, n=145) sta a −1.5 sigma, cioè dentro il rumore, ed è positivo sull'holdout.

Due avvertenze da non nascondere:

- **0.5 è un punto testato, non un ottimo di griglia.** Non ho stimato il peso su una griglia; ho
  verificato che questo valore regge fuori campione. È meno soggetto a overfitting di un ottimo
  cercato, ma non è "il" valore;
- **manca il passo R4**: attivarlo cambia i lambda di 1786 gare su 1792, quindi rende stale
  `DEFAULT_CALIBRATION` e richiede `npm run fit:calibration` più una nuova validazione appaiata
  prima del merge.

Per questo il default resta `redCardMatchWeight: 1`. È **l'unico parametro della coda che le misure
raccomandino di attivare**, e per farlo serve solo chiudere R4.

### 8.5 Task 14 — interazione di stile: implementata, non stimata

Un solo parametro (`styleVolumeInteraction`), neutro, con il test che ne verifica la firma di
interazione: due squadre entrambe estreme (alto volume o basso volume) alzano il totale gol atteso
perché il prodotto dei due scostamenti è positivo, mentre una estrema e una media no. Un termine che
si muove con una squadra sola non sarebbe un'interazione ma un fattore in più mascherato.

Il possesso, l'asse di stile più ovvio, resta inutilizzabile: **14.9%** di copertura (era 9.1% prima
di Task 1, quindi la correzione l'ha quasi raddoppiato senza avvicinarlo alla soglia utile). Il
volume dei tiri è l'unico asse con copertura 100%.

Non è stato stimato in questa batteria: il brief chiede di non aprire un cantiere nuovo prima che il
precedente abbia passato il cancello, e la coda davanti era piena. Resta pronto e neutro.

---

# SESSIONE 2

Dataset: `data/matches.json`, 8403 gare, rigenerato dopo Task 1. Tutte le misure sotto sono
successive a quella correzione.

---

## 9. P3 — distanza dal mercato: il numero di riferimento e dove si concentra

`npm run backtest:market -- --max 6000 --by phase,league,probability,season`, con il confronto reso
**appaiato** (stessa partita, due previsori): senza appaiamento la differenza fra due previsori non
è distinguibile dal rumore a queste numerosità.

Copertura quote: **99.4% sui Big Five, 0% sulle coppe UEFA**. Il confronto col mercato è quindi per
costruzione domestico, e le 3657 gare con quote sono tutte Big Five.

### 9.1 Il nuovo numero di riferimento

```
log loss modello : 0.9912
log loss mercato : 0.9697
divario APPAIATO : +0.0214 ± 0.0028   ->  7.6 sigma
```

**Lo spazio verso il mercato è 0.0214, non 0.017.** Il numero del brief v1 §1.3 era stimato su un
campione diverso e su 3000 gare senza appaiamento; questo è misurato su 3657 gare con il confronto
appaiato, ed è il valore da usare per dimensionare qualunque lavoro futuro.

### 9.2 L'ipotesi 1 di §5 è respinta, e nettamente

Il prompt di sessione 2 chiedeva di verificare per prima cosa se il costo di inizio stagione sia un
difetto del modello o una proprietà delle partite: *"se il divario modello-mercato nelle prime tre
giornate è uguale a quello del resto della stagione, non c'è niente da correggere"*.

```
fascia   |    n | logLoss mod | logLoss mkt | divario  | err.std | sigma | edge 1/X/2
01-03    |  296 |      1.0118 |      0.9539 | +0.0579 |  0.0135 |  4.28 | -1.4 -0.3 +1.7pp
04-06    |  275 |      0.9703 |      0.9444 | +0.0259 |  0.0103 |  2.51 | -1.1 -0.5 +1.7pp
07-10    |  365 |      0.9911 |      0.9687 | +0.0224 |  0.0085 |  2.64 | -0.8 -0.6 +1.4pp
11-19    |  838 |      0.9825 |      0.9702 | +0.0123 |  0.0056 |  2.19 | -0.2 -0.9 +1.1pp
20+      | 1883 |      0.9949 |      0.9759 | +0.0190 |  0.0038 |  5.03 | -0.7 -0.5 +1.2pp
```

Due letture, entrambe decisive:

1. **Il mercato prevede le prime tre giornate MEGLIO della media stagionale**: 0.9539 contro 0.9759
   della fascia 20+. Non sono partite intrinsecamente più difficili — sono partite in cui chi ha
   l'informazione giusta fa *meglio* del solito.
2. **Il divario del modello nelle prime tre giornate è 0.0579, tre volte quello di fine stagione**
   (0.0190) e più del doppio di qualunque altro segmento. È il singolo deficit più grande
   dell'intera segmentazione.

L'ipotesi "non è un difetto del modello ma della realtà" è **falsa**. Il costo di inizio stagione è
del modello, è grande, ed è il posto dove conviene lavorare. Il segmento **non va rimosso** dalla
lista dei problemi: va messo in cima.

La colonna edge dice anche in che direzione sbaglia: nelle prime tre giornate il modello dà 1.7pp in
più alla trasferta e 1.4pp in meno alla casa rispetto al mercato — coerente con l'osservazione di
§2.1 del brief v1, che resta valida come descrizione anche se la sua spiegazione era sbagliata.

### 9.3 Per lega: la Premier è quasi a livello di mercato

```
lega   |    n | logLoss mod | logLoss mkt | divario  | sigma
eng.1  |  784 |      0.9942 |      0.9840 | +0.0102 |  1.60
esp.1  |  809 |      0.9812 |      0.9581 | +0.0231 |  4.26
fra.1  |  633 |      0.9923 |      0.9643 | +0.0281 |  3.92
ger.1  |  633 |      0.9965 |      0.9695 | +0.0270 |  3.98
ita.1  |  798 |      0.9933 |      0.9721 | +0.0211 |  3.49
```

In Premier League il divario **non è distinguibile dal rumore** (1.6 sigma). Nelle altre quattro sì,
e vale 0.021-0.028. Vale la pena capire cosa la Premier abbia di diverso: è la lega con più dati per
squadra, e l'unica dove il modello regge il confronto.

### 9.4 Per fascia di probabilità: un difetto di forma, non di livello

```
fascia   |    n | divario | edge 1 / X / 2
<40%     |  649 | +0.0208 | +0.4 -2.1 +1.7pp
40-50%   | 1180 | +0.0190 | -0.1 -1.5 +1.6pp
50-60%   |  880 | +0.0223 | -0.6 -0.3 +0.9pp
60-70%   |  552 | +0.0203 | -1.8 +0.9 +0.8pp
>70%     |  396 | +0.0297 | -3.0 +2.1 +0.9pp
```

Il divario è **uniforme** su tutte le fasce: non è concentrato sulle partite incerte. Ma la colonna
edge cambia segno lungo la scala, ed è la cosa più interessante trovata in questa sessione:

- sulle partite molto sbilanciate (>70%) il modello dà **3.0pp IN MENO** al favorito del mercato, e
  2.1pp in più al pareggio;
- sulle partite molto incerte (<40%) dà 2.1pp in meno al pareggio.

Questo suggeriva che il modello fosse **troppo poco** sicuro sui favoriti forti — l'opposto della
diagnosi del brief v1 — e che `asymmetryShrink = 0.71` comprimesse troppo agli estremi.

> **RITIRATA.** L'ipotesi è stata testata subito contro gli ESITI, invece che contro il mercato, ed è
> caduta. Vedi §14: sulla curva di affidabilità del modello (5194 gare) le fasce estreme stanno a
> **+0.0083 ± 0.0126, cioè 0.66 sigma**. Il confronto col mercato mostrava una differenza di 3pp fra
> due previsori; la differenza fra il modello e ciò che poi succede non è distinguibile dal rumore.
> Sono due domande diverse, e avevo risposto alla seconda usando la prima.
>
> Il difetto solido è un altro, e §14 lo misura.

---

## 10. P2 — audit dello strumento difettoso

`diag_paired_ab.mjs` e `diag_season_phase.mjs` passavano a `predictFromMatches()` un array filtrato
alle sole competizioni domestiche. Il difetto era nel sorgente inlinato nel brief v1.

### 10.1 Cosa poteva essere contaminato, e cosa lo era davvero

Il filtro tocca solo ciò che legge l'array **non filtrato**: `recentLoad()` (Task 6),
`resolveCurrentSeason()` (Task 2, 3, 4) e `newcomerIndex()` (Task 4). Elo, medie e `stateMetrics`
sono identici, perché `predictFromMatches()` filtra comunque le competizioni per conto suo.

| misura | esito dell'audit |
|---|---|
| Task 1 (A/B fra dataset) | **sicura**: nessun meccanismo nuovo esisteva ancora; valuta solo gare domestiche in entrambi i bracci |
| Task 2, 3, 4 (sweep) | **sicure**: verificato che la stagione risolta è identica con e senza coppe su **0 previsioni diverse su 4571**. `newcomerIndex` è indicizzato per competizione, quindi identico per costruzione |
| Task 6 (prima misura) | **contaminata**, scoperta e rifatta in sessione 1 |
| Task 7, 8, 9, 14 | **sicure**: eseguite dopo la correzione |
| Calibrazione (R12) | **contaminata**, vedi sotto |

### 10.2 R12 va corretta: il refit non è "peggiore", è peggiore SOLO sui campionati

`fit_calibration.mjs` stima su tutte le competizioni supportate, coppe incluse. L'A/B di sessione 1
validava sui soli Big Five: stima su un insieme, validazione su un altro.

Rifatto sull'insieme giusto (3138 gare dell'holdout `2526`, coppe incluse):

```
variante            divario appaiato        IC 95%
refit completo        +0.0001            [-0.0012, +0.0014]
refit prudente        -0.0005            [-0.0013, +0.0003]
solo venueTilt        -0.0004            [-0.0012, +0.0004]
```

Aggregato **neutro**, non negativo. La scomposizione per competizione spiega perché:

```
eng.1 -0.0026   esp.1 -0.0028   fra.1 -0.0018   ger.1 -0.0030   ita.1 +0.0001
ucl   +0.0035   uel   +0.0021   uecl  +0.0029
```

**Il refit peggiora tutte e cinque le leghe e migliora tutte e tre le coppe.** Si annullano.

La conclusione operativa di R12 non cambia — `DEFAULT_CALIBRATION` resta il valore giusto per i
campionati, che sono il grosso dell'uso — ma la sua *motivazione* sì, ed è più utile della
precedente: **una calibrazione unica è un compromesso fra due regimi diversi**, e i due ottimi sono
distinguibili. Ipotesi generata sull'holdout, quindi da testare con stima sul training prima di
adottarla (in corso).

### 10.3 Indurimento dello strumento (R11)

`reportDifference()` stampa ora una riga obbligatoria **GARE TOCCATE DAL MECCANISMO: n/N (x%)** per
ogni variante, e `diag_paired_ab.mjs` **esce con codice 2** se una variante non tocca nessuna gara.
Un risultato "nessun effetto" con zero gare toccate non è un risultato: è uno strumento rotto.

Aggiunto anche `--include-europe`, perché valutare su un insieme diverso da quello di stima è
l'errore che questa sezione documenta.

---

## 11. P1 — Task 9 (peso dei rossi): **chiuso come negativo**

Era l'unico parametro positivo su entrambe le finestre alla fine della sessione 1, e non aveva
passato R4. Il prompt di sessione 2 avvertiva esplicitamente: *"La tentazione di salvare l'unico
positivo è esattamente il bias che R6 e R7 esistono per bloccare."*

### 11.1 La ricalibrazione non serve (R4 eseguita, R12 confermata)

`fit_calibration --hyperparameters '{"redCardMatchWeight":0.5}' --train-until 2025-05-31` produce
**gli stessi parametri** del refit senza Task 9:

```
parametro                    produzione   refit senza T9   refit con T9
asymmetryShrink                  0.7100         0.7111         0.7095
asymmetryShrinkLowQuality        0.3000         0.0000         0.0000
levelShrink                      0.4500         0.3926         0.3965
venueTilt                        0.0180         0.0023         0.0023
rho                             -0.0400         0.0132         0.0127
```

Attivare Task 9 **non sposta l'ottimo di calibrazione**, quindi non rende stale
`DEFAULT_CALIBRATION`. Verificato anche in A/B sull'holdout: `t9 + calibrazione attuale` dà +0.0018,
`t9 + refit completo` dà **−0.0002**, `t9 + refit prudente` dà +0.0018. La ricalibrazione o non
serve o toglie il guadagno.

### 11.2 Regola dichiarata prima di guardare, e suo esito

L'IC sull'holdout domestico era `[−0.0001, 0.0035]`: lo zero sul bordo, 2.0 sigma esatti. Non
"chiaramente incluso", ma nemmeno solido. **Regola fissata prima di eseguire**: allargare il
campione fuori campione alle coppe — stesso meccanismo, stesso valore, stessa metrica — e attivare
solo se il risultato resta ≥ 2 sigma senza segmenti peggiorati oltre 2 sigma.

```
holdout domestico  (1792 gare) : +0.0018 ± 0.0009  =  2.0 sigma
holdout allargato  (3138 gare) : +0.0008 ± 0.0005  =  1.6 sigma

per competizione, campione allargato:
  eng.1 -0.0012 ± 0.0013    esp.1 +0.0019 ± 0.0019    fra.1 +0.0030 ± 0.0026
  ger.1 +0.0038 ± 0.0022    ita.1 +0.0020 ± 0.0019
  ucl   -0.0020 ± 0.0010    uel   +0.0004 ± 0.0007    uecl  +0.0001 ± 0.0005
```

**Entrambe le condizioni falliscono**: 1.6 sigma è sotto la soglia, e la Champions peggiora di 2
sigma esatti. Anche il criterio originale del brief v1 per questo task — "nessun peggioramento su
nessun segmento" — non è più soddisfatto una volta incluse le coppe.

### 11.3 Decisione

`redCardMatchWeight` resta **1**. Task 9 è chiuso come negativo.

Il meccanismo e il test restano, con questa misura scritta accanto (R10): l'effetto è chiaramente
positivo sui campionati (4 leghe su 5, fino a +0.0038 in Bundesliga) e chiaramente negativo in
Champions. Applicarlo alle sole competizioni domestiche sarebbe la mossa ovvia — **ed è esattamente
quello che non si può fare**, perché quella distinzione l'ho vista sull'holdout. Per adottarla
servirebbe pre-registrarla e stimarla sul training, e sarebbe un test nuovo, non il salvataggio di
questo.

Con questo, **nessuno dei nove parametri implementati nelle due sessioni entra in produzione.** Le
uniche modifiche che cambiano le previsioni restano le correzioni di dati e definizioni: gli alias
di Task 1, il rilevamento delle neopromosse di Task 4, la bidirezionalità di `lineup_strength` di
Task 13.

---

## 12. P5 — pulizia dei ganci (R10) e correzione di `restDays`

### 12.1 Ganci rimossi

`momentumResidualWeight` (Task 7), `overperformanceExponent` (Task 8) e
`styleVolumeInteraction` (Task 14) sono stati **rimossi dal codice**. La sessione 1 li aveva
lasciati neutri, cioè aveva ricreato l'anti-pattern che il brief v1 §2.8 denunciava.

Conservati con la misura scritta accanto, come previsto da R10:
- i **residui di rendimento** (`resultResidual3/10`, `xgResidual5`) restano esposti come
  diagnostica per `diag_form_orthogonality.mjs`, con nel commento la tabella che ha respinto il
  loro uso nel lambda;
- i **fattori europei di Task 6** restano, con accanto la direzione misurata (−4.5pp di
  probabilità di vittoria dopo una trasferta UEFA, −1.9 sigma su 1128 osservazioni) e il motivo
  per cui sono spenti;
- `redCardMatchWeight` resta, con la misura di §11.

### 12.2 `restDays` era sbagliato, ora non lo è

Non un'ipotesi respinta: un **dato sbagliato**. Per una previsione domestica `chronological` è
filtrato alle sole competizioni domestiche, quindi `state.lastDate` era la data dell'ultima gara di
*campionato* e una squadra reduce dalla Champions del mercoledì risultava riposata da sette giorni
invece che da tre.

Corretto: `recentLoad()` restituisce ora anche `lastMatchGapDays`, letto dal calendario completo, e
`stateMetrics()` lo usa. Le coppe **non** entrano in Elo e medie, che restano costruiti sulle sole
competizioni pertinenti; entrano solo nella risposta a "quando questa squadra ha giocato l'ultima
volta". Test: `tests/true-rest-days.test.js`, scritto prima e fallito sul codice precedente (7
invece di 3).

Misura sull'holdout (1792 gare), confronto appaiato fra vecchio e nuovo comportamento:

```
riposo creduto in più, per gara (somma delle due squadre): 1.37 giorni
gare toccate: 370/1792 (20.6%)
differenza appaiata: -0.0002 ± 0.0004   IC 95% [-0.0009, +0.0005]
per lega: eng -0.0000, esp +0.0000, fra -0.0005, ger -0.0002, ita -0.0004
```

**Indistinguibile da zero.** Il dato adesso è giusto e il log loss non se ne accorge. Va tenuto
comunque: correggere un input sbagliato non richiede che il correggerlo paghi, e lascia il modello
in uno stato in cui la prossima ipotesi sul calendario è misurabile invece che confusa da un errore
di partenza.

Effetto sul backtest di riferimento: `ita.1` passa da 0.9883/0.525 a **0.9886/0.527**.

### 12.3 Invariante di `model.test.js` ristretta

L'invariante "aggiungere le partite europee non cambia nulla di una previsione domestica" era
**falsa come proprietà desiderabile**: nascondeva il difetto sopra. È stata ristretta a ciò che
deve ancora valere — medie, numerosità e aggiornamenti Elo restano quelli delle sole gare
domestiche — mentre il riposo, e quindi il decadimento per inattività, ora usano il calendario vero.

---

## 13. P2 (seguito) — la calibrazione dedicata alle coppe **non regge il test corretto**

§10.2 aveva generato sull'holdout l'ipotesi che coppe e campionati avessero ottimi di calibrazione
distinguibili (il refit domestico migliorava le coppe di +0.0021…+0.0035). Testata come si deve —
stima su `2324`+`2425` **solo coppe**, validazione sull'holdout `2526` **solo coppe**, 1346 gare:

```
variante                        differenza appaiata      IC 95%
calibrazione coppe (completa)      -0.0004 ± 0.0019   [-0.0041, +0.0033]
calibrazione coppe (rho teorico)   -0.0028 ± 0.0012   [-0.0050, -0.0006]
```

**Nessun guadagno**, e la versione con `rho` al valore teorico peggiora significativamente. Il
miglioramento visto in §10.2 era un artefatto dell'holdout, non una proprietà riproducibile.

`DEFAULT_CALIBRATION` resta invariata, ora per la seconda volta e per due strade diverse. È il
motivo per cui l'ipotesi va generata su una finestra e verificata su un'altra: questa sarebbe
passata per buona con un solo sguardo alla scomposizione per competizione.

---

## 14. La curva di affidabilità dice dove il modello sbaglia davvero

L'ipotesi di §9.4 (sotto-sicurezza sui favoriti forti) nasceva dal confronto col **mercato**. La
domanda giusta però è il confronto con gli **esiti**: che il modello dia 3pp meno del mercato al
favorito è interessante, ma dice qualcosa sul modello solo se poi il favorito vince davvero più
spesso di quanto il modello dica.

`npm run diagnose -- --competition domestic --max 6000 --bins 12`, 5194 gare dei Big Five,
bande di probabilità aggregate su esito casa **e** trasferta insieme:

```
fascia                       |    n | previsto | osservato | scarto             | sigma
estreme  (previsto >= 0.55)  | 1351 |    0.676 |     0.684 | +0.0083 ± 0.0126   |  0.66
medie    (0.30 - 0.55)       | 4547 |    0.444 |     0.448 | +0.0048 ± 0.0073   |  0.66
basse    (< 0.30)            | 4490 |    0.222 |     0.200 | -0.0224 ± 0.0061   | -3.67
```

**Alle fasce estreme non c'è nessun difetto** (0.66 sigma). L'ipotesi di §9.4 è ritirata: era
un'inferenza sul modello ricavata da un confronto fra due previsori, e i due non sono la stessa
misura.

**Il difetto vero è nella coda bassa**: il modello assegna il 22.2% a esiti che succedono il 20.0%
delle volte, con 3.67 sigma su 4490 osservazioni. Dà troppa probabilità a ciò che è improbabile.

Le marginali dicono dove finisce quella probabilità in eccesso:

```
esito       previsto   osservato   bias
casa          0.4370      0.4307   +0.0063
pareggio      0.2436      0.2566   -0.0130
trasferta     0.3194      0.3127   +0.0067
```

**Il modello sotto-prevede i pareggi di 1.3 punti percentuali**, e sovra-prevede casa e trasferta di
~0.65pp ciascuna. È lo stesso fenomeno visto da due lati: la probabilità che manca al pareggio è
quella di troppo sulla vittoria dell'outsider, che è ciò che popola le fasce basse.

Questo è un difetto di `rho`, il parametro di Dixon-Coles che governa la correlazione sui punteggi
bassi e quindi il tasso di pareggi — non di `asymmetryShrink`. E c'è un indizio storico che lo
conferma: il commento di `DEFAULT_HYPERPARAMETERS` in `model.js` motiva `rho = -0.04` dicendo che
lascia *"il bias residuo sui pareggi più vicino a zero (-0.4pp contro -1.4pp con rho = 0)"*. Oggi
quel bias misura **-1.30pp**, cioè è tornato al valore che quel commento attribuiva a `rho = 0`.

La spiegazione più semplice è che la correzione dei dati di Task 1 abbia spostato la distribuzione
dei lambda abbastanza da rendere stale proprio quel parametro. È una previsione verificabile e la
direzione è nota in anticipo (Dixon-Coles documenta rho negativo sui punteggi bassi, e più negativo
significa più pareggi), quindi è un test pulito: misurato su train e validato su holdout.

---

## 15. P6 — `quality.score` saturo: **nessuna delle due opzioni proposte**

La domanda era se ritirare il ramo di bassa qualità (`asymmetryShrinkLowQuality = 0.30`) come codice
morto, oppure ritarare la scala di `dataQuality`. La distribuzione, su 6000 gare dalla cache di
`fit_calibration`, dice che la premessa comune alle due opzioni è sbagliata.

```
insieme                n     min    p05     p25   mediana   p95    max    <0.90   <0.75
tutte le competizioni  6000  0.451  0.743  0.935   1.000   1.000  1.000   14.5%    5.4%
solo Big Five          3690  0.483  0.995  1.000   1.000   1.000  1.000    3.8%    0.1%
solo coppe UEFA        2310  0.451  0.597  0.820   0.935   0.980  1.000   31.6%   13.9%
```

**Il ramo di bassa qualità è morto per i campionati e vivo per le coppe.**

- Nei Big Five `quality.score` è di fatto la costante 1.0: il 5° percentile è **0.995** e solo lo
  0.1% delle gare scende sotto 0.75. `shrink` vale 0.710 per la quasi totalità delle previsioni, e
  `asymmetryShrinkLowQuality` non fa nulla.
- Nelle coppe il 31.6% delle gare sta sotto 0.90 e il 13.9% sotto 0.75, con `shrink` che scende fino
  a ~0.485. **Ritirarlo come codice morto cambierebbe in silenzio un terzo delle previsioni di
  coppa** — che è esattamente il tipo di modifica non misurata che questo lavoro esiste per evitare.

C'è anche una nota storica che conferma la lettura. Il commento di `DEFAULT_CALIBRATION` in
`model.js` giustifica il valore 0.30 dicendo che *"nel dataset la qualità non scende mai vicino a
zero (5° percentile 0.74)"*. Quel numero è ancora esatto **in aggregato** (0.743) — ma è la media di
due regimi che non si somigliano: 0.995 nei campionati, 0.597 nelle coppe. È lo stesso errore di
lettura di §10.2 sulla calibrazione, sullo stesso confine.

### Decisione

Nessuna delle due opzioni. Il ramo **resta** perché governa un terzo delle previsioni di coppa, e
non si ritara `dataQuality` perché non c'è evidenza che una maggiore discriminazione aiuti: Task 2
ha misurato che abbassare `quality` a inizio stagione **peggiora**, quindi restituire potere
discriminante a un indicatore che poi comprime di più andrebbe nella direzione già falsificata.

Quello che cambia è la **documentazione**: il parametro non è "inerte" come sembrava, è inerte
**dove si guardava**. Chi lo leggerà ora trova accanto la distribuzione divisa per regime.

---

## 16. C1 — `rho` e il deficit di pareggi: **respinto, ed è il sesto**

§14 misura un difetto solido: il modello sotto-prevede i pareggi di 1.30pp e sovrastima le fasce
basse di −0.0224 ± 0.0061 (3.67 sigma su 4490 osservazioni). Il parametro che governa il tasso di
pareggi è `rho`, la correzione di Dixon-Coles sui punteggi bassi, e la direzione è nota a priori:
più negativo, più pareggi.

### 16.1 La direzione è confermata (R6)

Con `rho = -0.10`, su 2500 gare dei Big Five:

```
esito      | rho=-0.04 (attuale) | rho=-0.10
casa       |              +0.0011 |  -0.0055
pareggio   |              -0.0056 |  +0.0076
trasferta  |              +0.0045 |  -0.0021
```

Il bias sui pareggi si muove nella direzione giusta — e a −0.10 **lo scavalca**, passando da −0.56pp
a +0.76pp. L'errore di calibrazione atteso peggiora leggermente su tutti e tre gli esiti
(casa 0.0182→0.0185, pareggio 0.0071→0.0079, trasferta 0.0118→0.0132).

### 16.2 La stima non regge fuori campione

```
rho      train (2779 gare)          holdout 2526 (1792 gare)
-0.06    +0.0003 ± 0.0002           +0.0002 ± 0.0003
-0.08    +0.0006 ± 0.0004           +0.0002 ± 0.0005
-0.10    +0.0007 ± 0.0006           +0.0002 ± 0.0008
-0.13    +0.0007 ± 0.0009           -0.0001 ± 0.0011
```

Sul training il guadagno cresce e va in plateau intorno a −0.10 (+0.0007, 1.2 sigma). **Sull'holdout
vale +0.0002 per qualunque valore**, cioè niente.

### 16.3 Cosa insegna

Un difetto di calibrazione **reale e misurato a 3.67 sigma** la cui correzione **non paga**. Non è
una contraddizione: spostare 1.3 punti percentuali fra il pareggio e gli altri due esiti è quasi
neutro nel log loss, perché il log loss guarda la probabilità dell'esito che è davvero successo, e
quella probabilità cresce per le partite finite in pareggio esattamente quanto cala per le altre.

Ha una conseguenza pratica precisa: **il bias marginale sui pareggi non è una leva utile.** Va
tenuto come diagnostica — dice che la forma della distribuzione non è perfetta — ma inseguirlo non
avvicina al mercato. `rho` resta a −0.04.

Con questo salgono a **sei** le ipotesi indipendenti testate e respinte in due sessioni. Cinque
riguardavano lo scontare la forza ereditata (§3.1 del BRIEF-v2); questa riguarda la forma della
distribuzione degli esiti, ed è quindi indipendente dalle altre.

---

## 17. C2 — bias arbitro: **misurato, e il segnale era tutto leakage**

Il brief v1 metteva lo scraping delle designazioni arbitrali come contenuto principale di Task 10.
Il prompt di sessione 2 ha invertito l'ordine — misurare prima, scrapare solo se l'effetto esiste —
ed è stata la decisione giusta.

### 17.1 Cablaggio (fatto)

`refereeHomeBias` era un parametro di `predictFromMatches` che **nessun chiamante passava mai**: il
gancio esisteva, era testato, ed era inerte. Ora `predictMatchdayFromMatches` lo risolve **per
partita** da `payload.referee_stats` leggendo `fixture.referee`, e `app.js` passa la tabella. Vale 0
quando l'arbitro è ignoto o non tracciato — cioè oggi per ogni partita futura.
Test: `tests/referee-bias-wiring.test.js`.

### 17.2 Prima misura: +0.0050 ± 0.0012, quattro sigma

Sulle 1114 gare con arbitro noto e tracciato (21.5% del dataset, tutte `eng.1`, 34 arbitri):

```
log loss senza bias : 0.9878
log loss con bias   : 0.9828
differenza appaiata : +0.0050 ± 0.0012   IC 95% [0.0026, 0.0074]   -> 4.2 sigma
```

Il risultato più grande di due sessioni, e **falso**.

### 17.3 Il segnale era leakage temporale

`compute_referee_stats()` in `update_europe_data.py` calcola il bias di ogni arbitro su **tutte** le
partite concluse che ha diretto — **inclusa quella che si sta prevedendo**. Il bias dell'arbitro
conteneva quindi, in parte, il risultato da indovinare.

Rifatta la misura **in avanti**, ricalcolando il bias di ogni arbitro con la stessa formula
(shrinkage bayesiano, `prior_strength = 40`) ma **solo sulle sue partite precedenti** alla data
della previsione:

```
gare valutate: 1093 (36 scartate: primo incarico dell'arbitro, nessuna storia)
bias applicato: |medio| 0.0262   (contro 0.0334 della versione contaminata)
log loss senza bias : 0.9872
log loss con bias   : 0.9871
differenza appaiata : +0.0001 ± 0.0010   IC 95% [-0.0017, 0.0020]

per stagione:  2324 -0.0009 ± 0.0013   2425 +0.0002 ± 0.0018   2526 +0.0011 ± 0.0019
```

**Zero.** Il 4.2 sigma era interamente contaminazione.

### 17.4 Decisione

**Task 10 è chiuso come negativo, e lo scraping delle designazioni non va fatto.** È la voce più
costosa della coda del brief v1, e la misura che la chiude costa un'ora invece di un progetto.

Due conseguenze da non perdere:

1. **`payload.referee_stats` non è utilizzabile in un backtest**, mai, perché è calcolato in-sample.
   Chi lo userà per una misura futura deve ricalcolarlo in avanti, come fatto qui. È lo stesso
   difetto che il brief v1 §Task 15 attribuiva agli archivi di sentiment — *"un leakage anche
   piccolo produce un backtest entusiasmante e un modello inutile in produzione"* — e si è
   presentato nella fonte più insospettabile del progetto.
2. Il cablaggio resta comunque: è corretto, è testato, non fa nulla finché il campo `referee` è
   vuoto, e ha permesso di fare la misura. Ma nessuno lo accenda aspettandosi un guadagno.

---

## 18. Q1 — il modello in produzione non era il modello misurato: **corretto e reso non ripetibile**

Difetto trovato dopo la chiusura della sessione 2. `app.js` passava a `predictFromMatches` due
input che **nessuno** script di misura passava:

```
app.js:200   teamContext:  payload.team_context    -> backtest_model.mjs: assente
app.js:206   refereeStats: payload.referee_stats   -> backtest_model.mjs: assente
```

Ogni numero di log loss prodotto in due sessioni descrive quindi un modello con
`teamContext = null` e nessun bias arbitro, cioè non quello che gira sul sito.

### 18.1 Quanto vale l'esposizione, misurata

`scripts/diag_prod_vs_measured.mjs`, stesse partite dal 2024-08-01, confronto appaiato fra le due
configurazioni:

| lega | gare toccate | misurato | produzione | differenza appaiata | sigma |
|---|---|---|---|---|---|
| `fra.1` | 585/621 (94.2%) | 0.9936 | 0.9934 | +0.0002 ± 0.0010 | 0.21 |
| `esp.1` | 644/774 (83.2%) | 0.9806 | 0.9806 | +0.0000 ± 0.0004 | 0.02 |
| `ita.1` | 478/768 (62.2%) | 0.9863 | 0.9863 | −0.0000 ± 0.0006 | −0.01 |
| `eng.1` | 0/769 (0.0%) | 1.0015 | 1.0015 | — | — |

Tre letture, e la terza decide:

1. **L'esposizione è reale ma vale zero.** Il fattore muove la previsione su oltre nove gare
   francesi su dieci e non sposta il log loss di una cifra misurabile.
2. **Non è retro-applicabile senza leakage.** `player_context` è uno snapshot unico con
   `as_of: 2026-08-23`, posteriore a tutto il dataset: la misura qui sopra confronta "produzione
   con snapshot anacronistico" contro "backtest senza", quindi dice quanto è grande l'esposizione,
   non se un `lineup_strength` correttamente datato servirebbe.
3. **L'asimmetria per lega non è calcistica.** 94% delle gare francesi contro 0% delle inglesi: la
   selezione dipende da quali squadre l'enrichment è riuscito a risolvere, non dal calcio.

`fra.1` è il caso che chiude la questione: è la lega con l'esposizione più alta, ed è anche quella
con l'intervallo di confidenza più largo attorno allo zero.

### 18.2 Decisione: opzione (a)

**Entrambi gli input sono spenti in produzione dal 27/08/2026.** `refereeStats` non era nominato in
Q1 — il prompt sessione 3 diceva che «l'unica differenza è `teamContext`» — ma è la stessa
divergenza, e su di esso R13 è ancora più netto: è confermato contaminante (§17), quindi era
esattamente la terza opzione che R13 vieta, «usato in produzione e ignorato in misura». In
produzione era comunque inerte, perché nessuna fonte pubblica le designazioni e `fixture.referee` è
vuoto per ogni partita futura: spegnerlo non cambia una sola previsione, toglie solo un effetto
armato che nessun backtest può vedere.

Il codice di entrambi resta in `model.js`, vivo e testato (`tests/team-context.test.js`,
`tests/referee-bias-wiring.test.js`), annotato con la misura che lo respinge — è R10 nella sua
seconda forma, e lascia aperta l'opzione (b), un `player_context` versionato nel tempo.

Effetto collaterale sull'interfaccia: la sezione "Contesto pre-partita" della tab "Dati extra"
mostrava i moltiplicatori di `team_context` e ora avrebbe mostrato "non disponibile" per sempre.
Rimossa.

### 18.3 Il criterio di accettazione: la divergenza non deve poter tornare

Correggerla una volta non basta — non c'era niente che impedisse di reintrodurla, perché i due
chiamanti si costruivano le opzioni ciascuno per conto proprio.

`prediction-inputs.js` è ora l'unica sorgente degli input non identitari. Ogni chiamante scrive

```js
{ ...modelInputs(...), <sole chiavi di identità della partita> }
```

e `modelInputs()` rifiuta a runtime ciò che non è dichiarato in `MODEL_INPUT_DEFAULTS`.
Ci passano tutti e cinque i chiamanti che prevedono: `app.js`, `schedina.js`,
`schedina-page.js`, `scripts/backtest_model.mjs`, `scripts/backtest_vs_market.mjs`. Restano fuori
`tune_hyperparameters.mjs` e `fit_calibration.mjs`, che **stimano**: passano `hyperparameters` per
costruzione, ed è il loro oggetto di ricerca, non un input della previsione.

I due chiamanti della schedina erano una terza divergenza, mai nominata: passavano il solo
`competitionId`, quindi ignoravano sia `teamContext` sia le preferenze dell'utente. Ricondurli al
contratto non cambia una previsione — i default coincidono — ma li mette sotto lo stesso vincolo.

`tests/prediction-input-parity.test.js` analizza il **sorgente** dei chiamanti, non il loro
comportamento, perché il comportamento non può dire nulla di un input che non esiste ancora.
Fallisce in otto casi, tutti verificati per mutazione:

| mutazione | esito |
|---|---|
| `app.js` riaggiunge `teamContext:` a mano | fallisce |
| `app.js` smette di usare `modelInputs()` | fallisce |
| `backtest_model.mjs` aggiunge un input che la produzione non ha | fallisce |
| `backtest_vs_market.mjs` perde `modelInputs()` | fallisce |
| `schedina.js` torna a scriversi le opzioni a mano | fallisce |
| `schedina-page.js` perde `modelInputs()` | fallisce |
| `MODEL_INPUT_DEFAULTS` diverge dai default di `predictFromMatches` | fallisce |
| a `predictFromMatches` si aggiunge un'opzione non classificata | fallisce |

L'ultima riga è la più importante: obbliga a **decidere** da quale lato debba arrivare ogni nuova
opzione, invece di arrivarci per omissione — che è come ci si è arrivati questa volta.

### 18.4 Cosa non cambia

Nessun numero di log loss misurato in due sessioni va rivisto: erano tutti prodotti con
`teamContext = null`, che è **la configurazione ora in produzione**. È la divergenza a essere stata
eliminata, non la misura a essere stata sbagliata. Backtest di controllo dopo la modifica,
`ita.1` dal 2024-08-01: log loss 0.9865, identico a prima.

---

## 19. Q2 — audit leakage sistematico (R13): **un difetto trovato, e non era fra i sospettati**

Il prompt sessione 3 elencava quattro cose da verificare: `player_context`, `team_context.elo`,
`coverage` e gli aggregati di competizione. L'audit fatto campo per campo le ha assolte tutte —
e ha mancato il difetto, che stava altrove. La procedura che l'ha trovato non guarda i campi.

### 19.1 La procedura: invarianza per troncamento

Ispezionare i campi uno per uno è già stato fatto in sessione 2, e ha lasciato passare
`referee_stats` per due sessioni. La verifica che non dipende da quali campi si sospettano è
chiedere al modello la stessa previsione due volte:

- **A** con il dataset intero, come lo riceve un backtest (contiene gare successive alla previsione);
- **B** con il dataset troncato a `date < cutoff`, cioè con tutto ciò che non poteva essere noto rimosso.

Se A e B divergono, qualcosa legge il futuro — quale campo sia è una domanda successiva. È
esaustivo per costruzione, e copre anche gli aggregati calcolati **dentro** `model.js`, non solo
quelli precalcolati nel payload. Strumento: `scripts/diag_leakage_truncation.mjs`.

Primo esito, 150 gare campionate uniformemente su otto competizioni, più 313 gare di apertura di
stagione: **0 divergenze, Δ massimo 0.00e+0**.

### 19.2 Lo zero era condizionato, e la condizione è temporanea

Il risultato va interrogato invece che incassato. `currentSeason` alimenta tre meccanismi, e tutti
e tre sono a valore **neutro per decisione misurata**: `seasonEloRegression` 1,
`seasonQualityWeight` 0, cold-start neopromosse 0/1. Un consumatore neutro rende invisibile
qualunque difetto a monte.

Ripetendo il confronto con i consumatori accesi, uno per volta, su 62 gare di apertura:

```
default (tutti neutri)          0/62 divergenti   max Δ 0.00e+0
seasonEloRegression 0.80        2/62 divergenti   max Δ 1.15e-3
seasonQualityWeight 0.50        2/62 divergenti   max Δ 3.23e-2
newcomerEloAnchor 1.00          0/62 divergenti   max Δ 0.00e+0
newcomerEloRetention 0.70       0/62 divergenti   max Δ 0.00e+0
```

3.2 punti percentuali su una probabilità 1X2. Il difetto non era assente: era **disarmato**.

### 19.3 Il difetto: la stagione veniva dedotta, non passata

`resolveCurrentSeason(matches, predictionDate)` deduceva la stagione dai confini delle stagioni
presenti nell'array. Il commento che difendeva questa scelta diceva che leggere l'array non
filtrato è sicuro perché «è informazione di calendario, nota in anticipo e priva di risultati», e
che leggerla da `chronological` «darebbe la risposta sbagliata proprio nel caso che conta, perché
quell'array si ferma al cutoff».

La seconda metà è vera in backtest e **falsa in produzione**. `payload.matches` contiene **solo
gare concluse** — verificato: 0 su 8403 con `completed === false`, 0 con gol nulli, data massima
2026-08-23 — mentre le fixture future stanno in un array separato. Quindi anche in produzione
l'array si ferma a oggi.

Alla prima giornata di una stagione nuova:

| | array | stagione risolta |
|---|---|---|
| backtest | intero, contiene tutta la stagione N | N |
| produzione | solo gare concluse, nessuna di N | ripiego sulla precedente |

È la stessa divergenza di Q1 in un punto diverso, e nasconde la stessa trappola: chi un giorno
stimasse `seasonQualityWeight` su un backtest lo stimerebbe contro un rilevamento di stagione che
la produzione non sa riprodurre, e misurerebbe in parte un guadagno fittizio. La coda di §4 del
prompt indica «onestà dell'incertezza» come valore residuo, cioè `quality.score`, cioè proprio
`seasonQualityWeight`: la mina era sul sentiero indicato.

### 19.4 Correzione

`season` diventa una chiave di **identità della gara** (`FIXTURE_IDENTITY_KEYS`), come
`competitionId`: nota in anticipo, priva di risultati, diversa a ogni chiamata, e soprattutto
**uguale sui due lati** perché viene dalla gara stessa. `predictMatchdayFromMatches` la propaga da
`fixture.season`; i due backtest la passano da `match.season`. `resolveCurrentSeason()` resta come
ripiego per i chiamanti sintetici, non come strada di produzione.

Neutralità verificata bit per bit: **1434 gare** (906 a campione uniforme + 528 aperture di
stagione), previsioni cambiate **0**, `currentSeason` risolta diversamente **0**. Backtest di
controllo `ita.1` dal 2024-08-01: 0.9865, invariato. Nessun numero misurato in tre sessioni va
rivisto — la divergenza era tutta sul lato produzione, che nessuna misura guardava.

Con la correzione, i cinque scenari di §19.2 tornano tutti a 0/62.

`tests/leakage-truncation.test.js` fissa l'invariante. Gira con gli iperparametri di stagione
**accesi**, perché ai default darebbe verde su un difetto armato. Verificato per mutazione:
rimettere la deduzione in `predictFromMatches` lo fa fallire, e togliere la propagazione di
`fixture.season` da `predictMatchdayFromMatches` lo fa fallire — quest'ultimo caso il test di
parità di Q1 **non** lo vede, perché `predictionOptions()` in `app.js` non conosce la partita.

### 19.5 Verdetto sugli altri aggregati

| campo | verdetto | motivo |
|---|---|---|
| `home_goals`/`xg`/`shots`/`sot`/`red` | ✅ | fatti della gara stessa, e il modello filtra a `date < cutoff` |
| `date`, `home_team`, `away_team`, `season`, `competition_id`, `competition_type` | ✅ | calendario e identità, noti in anticipo |
| `league_strength` | ✅ | costante cablata per competizione (1570/1555/1550/1540/1520, 1500 in coppa), invariante per stagione — non stimata dai risultati |
| `importance` | ✅ | costante: 1.18 in coppa, 1.0 nei campionati |
| `recentLoad()` / `teamCalendar()` | ✅ | filtra esplicitamente `entry.when >= cutoff` |
| `newcomerIndex()` | ✅ | legge l'array intero ma solo (competizione, stagione, squadra), mai i gol, e guarda solo all'indietro |
| `resolveCurrentSeason()` | ❌ **corretto** | §19.3 |
| `referee_stats` | ❌ già chiuso | in-sample (§17), e dal 27/08/2026 non lo passa più nessuno |
| `team_context` (incl. `elo`) | ✅ non più un input | dal 27/08/2026 nessun chiamante lo passa (§18); resta letto solo da `settings.js`/`admin.js` per elenchi di squadre |
| `coverage`, `source_health`, `sources`, `domestic_leagues`, `generated_at`, `latest_season` | ✅ | nessun percorso di previsione li legge |
| `player_context` | ⚠️ vedi §19.6 | |

Nota di metodo: l'audit ha quasi mancato `home_xg`, perché `model.js` lo legge come
``match[`${side}_xg`]`` e un grep sul nome del campo non lo trova. Cercare i campi per nome non è
una procedura affidabile — è la ragione per cui §19.1 non lo fa.

### 19.6 `player_context`: non contamina, ma non è misurabile

`player_context` alimenta solo `estimatePlayerMarkets()`, che sta **a valle** della previsione: ne
riceve `lambdaHome`/`lambdaAway` come input e non restituisce nulla al modello. Non può quindi
contaminare nessun log loss 1X2, ed è per questo che l'invarianza di §19.1 non lo vede.

Resta però un caso R13 puro: è usato in produzione e **non è misurabile**, non per scelta ma per
impossibilità — non c'è modo di ricostruire lo stato di una rosa a una data passata con i dati che
la pipeline conserva. `estimatePlayerMarkets` non è mai stato validato contro nulla, ed è la voce
che §4 del prompt indica come valore residuo.

Un dettaglio che il prompt riportava in modo troppo generoso: `player_context` **non** è uno
snapshot unico al 2026-08-23. Gli `as_of` sono 14 date distinte:

```
2026-01   24 squadre su 95      2026-08   71 squadre su 95
```

Un quarto delle squadre coperte porta una fotografia di **gennaio 2026** applicata a partite di
agosto, sette mesi dopo — e 11 delle 46 squadre con `lineup_strength != 1` sono fra queste. Il
fattore spento in §18 non era solo a valore misurato nullo: per un quarto delle squadre coperte
era anche una formazione probabile vecchia di sette mesi. La stessa staleness vale per
`team_context`, che condivide gli `as_of`.

---

## 20. Q4 — fattore di dispersione condiviso

### 20.1 Pre-registrazione (R15) — scritta prima di qualsiasi log loss

R15 esiste perché la famiglia «correggere un difetto di calibrazione misurato» ha fallito nove
volte su nove. Questa sezione è stata scritta e salvata **prima** di eseguire qualunque stima:
tutto ciò che segue in §20.3 va letto contro questa griglia, non contro una griglia scelta dopo.

**Meccanismo.** Un fattore Z di media 1 e varianza φ moltiplica entrambi i lambda della stessa
partita. `sharedDispersion` = φ, neutro a 0, ramo Poisson separato per garantire la neutralità
bit per bit. Implementato e testato (`tests/shared-dispersion.test.js`) prima di misurare.

**Dati.** Tutte le otto competizioni supportate, come `fit_calibration.mjs`.
Stima: stagioni **2324 + 2425** (2023-06-27 → 2025-05-31, ~5265 gare).
Holdout: stagione **2526** (2025-07-08 → 2026-05-30, ~2713 gare). La stagione 2627 è esclusa:
425 gare di cui 40 domestiche, troppo poco e troppo sbilanciata.
Confronto **appaiato** (R3), `scripts/diag_paired_ab.mjs`, bootstrap 2000, seed fisso.

**Griglia.** φ ∈ {0, 0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.35}. Se l'ottimo di train cade
sull'estremo superiore, la griglia si estende **una sola volta**; se resta sull'estremo,
il parametro è dichiarato non identificato e la pista si chiude.

**Il φ portato sull'holdout è l'argmin di train, fissato prima di guardare l'holdout.** Un solo
valore, una sola volta.

**Soglia di successo — tutte e tre le condizioni, sull'holdout:**

1. differenza appaiata di log loss ≥ **+0.0015** (base − variante, positivo = variante migliore);
2. almeno **2σ**;
3. segno positivo in almeno **6 delle 8** competizioni.

Le tre soglie sono calibrate sul precedente che ha funzionato: Task 9 (peso dei rossi) fu
raccomandato con +0.0018 sull'holdout e tutti i segmenti positivi. Sotto +0.0015 il guadagno è
dello stesso ordine del rumore appaiato su un holdout di questa dimensione, e i nove rifiuti
precedenti stanno tutti sotto quella soglia.

**Decisione in caso di fallimento, dichiarata adesso:** se una qualsiasi delle tre condizioni non
regge, `sharedDispersion` **resta 0 in produzione** ed è il decimo rifiuto. Il codice resta in
`model.js`, testato e annotato con la misura che lo respinge (R10, seconda forma). Non si tenta
un secondo φ, non si cambia la finestra, non si ritaglia un sottoinsieme di competizioni dove
funziona: sarebbe scegliere la griglia dopo aver visto il risultato, che è ciò che R15 vieta.

**Attesa dichiarata:** rifiuto. Sia per la base 9/9, sia per §20.2.

### 20.2 Una premessa di Q4 è falsa, misurata prima di eseguire

Il prompt sessione 3 giustificava Q4 così: a differenza di `rho`, che «tocca solo le celle a
punteggio basso», il fattore condiviso alzerebbe «P(X=Y) su tutta la matrice invece che solo in
basso». Misurato sulla matrice, λ 1.55/1.20, φ = 0.10:

```
0-0   0.06393 -> 0.08809   +0.02416
1-1   0.11891 -> 0.11086   -0.00804
2-2   0.05529 -> 0.04947   -0.00582
3-3   0.01143 -> 0.01321   +0.00178
4-4   0.00133 -> 0.00257   +0.00124
pareggio totale         +0.01367
```

**Il guadagno sul pareggio è per il 177% dovuto allo 0-0**, e 1-1 e 2-2 ci perdono. Il meccanismo
non distribuisce nulla: agisce sulla distribuzione del TOTALE dei gol, spostando massa dal centro
(totali 2-4) verso entrambe le code.

```
totale 0   +0.02416      totale 3   -0.02714
totale 1   +0.01419      totale 4   -0.01604
totale 2   -0.01635      totale 6/7 +0.00598 / +0.00680
```

Questo cambia l'attesa in peggio, e va detto prima e non dopo. §14 misura due difetti insieme: i
pareggi sotto-previsti di 1.30pp **e** la banda bassa (previsto < 0.30) sovrastimata a −3.67σ, cioè
troppa probabilità su ciò che è improbabile. Il fattore condiviso corregge il primo **peggiorando
la premessa del secondo**: gonfia lo 0-0, che è precisamente un esito poco probabile a cui il
modello già assegna troppa massa. La direzione sull'1X2 è giusta, quella sulla matrice no.

La pre-registrazione resta quella di §20.1: la misura si fa comunque, perché costa poco e perché
la direzione dichiarata da R6 sull'1X2 è verificata. Ma l'attesa di rifiuto sale.

### 20.3 Esito: **respinto**, ed è il decimo

**Train, stagioni 2324+2425, 5056 gare, tutte le competizioni, confronto appaiato:**

```
base      0.9957
phi 0.02  0.9958   -0.0001
phi 0.05  0.9961   -0.0004
phi 0.08  0.9965   -0.0007
phi 0.12  0.9971   -0.0014
phi 0.18  0.9986   -0.0029
phi 0.25  1.0009   -0.0052
phi 0.35  1.0053   -0.0096
```

Monotono verso il basso. **L'argmin di train è φ = 0**, cioè il valore neutro, sull'estremo
inferiore della griglia. La pre-registrazione prevedeva l'estensione della griglia solo verso
l'alto: verso il basso non c'è dove estendere, perché φ < 0 non esiste (è una varianza).

Il φ da portare sull'holdout è quindi il modello base, e la condizione 1 (≥ +0.0015) non è
raggiungibile per costruzione. **Respinto secondo la regola dichiarata in §20.1.**

**Holdout, stagione 2526, 2713 gare** — eseguito comunque, non per rivedere la decisione ma per
capire il rifiuto:

```
phi 0.02   -0.0001            phi 0.05   -0.0005 ± 0.0003   IC [-0.0011, +0.0002]
phi 0.12   -0.0017 ± 0.0008   IC [-0.0034, -0.0001]
```

Stesso segno, stessa monotonia. Il meccanismo tocca il 100% delle gare (guardia R11 soddisfatta:
non è un rifiuto per strumento inerte, come lo era il primo `teamContext`).

`sharedDispersion` resta **0 in produzione**. Il codice resta in `model.js`, testato e annotato.

### 20.4 Perché è respinto: la premessa non regge fuori dai Big Five

La segmentazione dell'holdout non è uniforme, ed è la parte che insegna qualcosa:

```
phi 0.12, differenza appaiata per competizione
  eng.1  +0.0019      ucl   -0.0047
  ger.1  +0.0019      uecl  -0.0037
  fra.1  -0.0001      uel   -0.0062
  ita.1  -0.0012
  esp.1  -0.0024
```

I campionati sono neutri o leggermente positivi; **le tre coppe sono nettamente negative**, e sono
loro a decidere il segno aggregato. La ragione, misurata su 7769 gare dal 2023-06-27:

```
bias sul pareggio (previsto - osservato)   n      previsto  osservato   bias      sigma
Big Five,   tutte le stagioni              5154    0.2435    0.2565    -0.0130    -2.14
coppe UEFA, tutte le stagioni              2615    0.2463    0.2011    +0.0452    +5.76

per stagione:
  2324  Big Five -0.0207 (-1.90)     coppe +0.0406 (+2.66)
  2425  Big Five -0.0094 (-0.91)     coppe +0.0545 (+4.29)
  2526  Big Five -0.0093 (-0.90)     coppe +0.0392 (+3.00)
```

**Il difetto ha segno opposto nelle due popolazioni, stabilmente, in tutte e tre le stagioni.** Nei
Big Five il modello prevede troppo pochi pareggi (il difetto di §14, −1.30pp). Nelle coppe ne
prevede **troppi, di 4.5 punti percentuali a 5.76 sigma** — una miscalibrazione più grande e molto
più significativa di quella che ha motivato Q4, mai riportata prima perché §14 aveva misurato con
`--competition domestic`.

Ne segue che qualunque leva GLOBALE sul tasso di pareggi è un compromesso fra +4.5pp e −1.3pp, e
il compromesso perde: aiuta poco dove il difetto è piccolo e danneggia molto dove è grande e di
segno opposto. Questo spiega **due** dei dieci rifiuti con lo stesso meccanismo — Q4 qui e `rho`
in C1, che aveva train monotono e holdout piatto (§16). Non era rumore: era la somma di due
segnali opposti.

**Questo non è una proposta.** La conseguenza apparente — un parametro di pareggio dedicato alle
coppe — è già chiusa da §13 e da §6 del prompt sessione 3: la calibrazione dedicata alle coppe è
stata testata correttamente e respinta (−0.0004 ± 0.0019, e −0.0028 ± 0.0012 con rho teorico). È
un fatto da registrare, non una pista da riaprire.

### 20.5 Cosa conferma

R15 ha funzionato come previsto. La soglia e la decisione erano scritte prima, l'attesa dichiarata
era il rifiuto, e il rifiuto è arrivato senza margine di interpretazione: train monotono negativo,
holdout monotono negativo, argmin sul valore neutro.

Il conto sale a **dieci ipotesi su dieci** in cui correggere un difetto di calibrazione misurato
non paga fuori campione. §20.4 aggiunge una ragione strutturale a quella statistica: almeno per il
tasso di pareggi, "il difetto misurato" non era una quantità sola.

---

## 21. Q3 cancello 1 — la copertura c'è (79.7%), ma non dove serve

Il cancello 1 chiede, **prima di scrivere codice**, se il delta di rosa sia calcolabile per una
fetta rappresentativa di squadre, e chiude il task se la copertura roster × statistiche N−1 sta
sotto il 70% dei Big Five.

### 21.1 Le statistiche N−1 esistono già, e nessuno lo sapeva

Il prompt sessione 3 dava per scontato che le statistiche giocatore fossero disponibili «solo per
la stagione corrente» e che servisse estendere l'enrichment alla N−1. È sbagliato in entrambi i
sensi.

**Sono già su disco.** `.cache/understat/{Squadra}-{anno}.json` contiene, per ogni squadra e
stagione, un array `players` con `games, time, goals, xG, assists, xA, shots, key_passes, npg,
npxG, xGChain, xGBuildup` — produzione di stagione piena, quattro annate (2023, 2024, 2025, 2026),
96-97 squadre per annata, 11 MB in tutto. Nessuno scaricamento da fare.

**E la stagione corrente, che il prompt dava per acquisita, è la più debole.**
`enrich_competitions_players.py` gira con `samples_per_team = 2`: due partite per squadra. Nel
dataset la mediana di `appearances` per giocatore è **1** e il massimo **3**. Ciò che il prompt
chiama «statistiche giocatore per partita» è una fotografia della formazione con un po' di rumore
attaccato, non una produzione.

### 21.2 La misura del cancello

Misurata sulla continuità di rosa che il delta richiede: per ogni squadra della stagione N, quale
quota dei minuti giocati appartiene a giocatori di cui esiste una produzione N−1 **da qualche
parte** nei Big Five (quindi anche se trasferiti). Solo giocatori con ≥ 180 minuti: un dodicesimo
entrato quattro minuti non muove il delta e conterebbe come un buco senza esserlo.

Il confronto è per `id` Understat, stessa fonte su entrambi i lati, quindi **non** risente del
problema di alias fra fonti diverse che Task 1 ha dovuto correggere.

Due coppie di stagioni complete, indipendenti:

```
stagione N   squadre   giocatori   copertura      copertura        stessa    trasferiti   non
             valide    >= 180'     per giocatore  PESATA MINUTI    squadra   nei Big5     trovati
2526 <- 2425    97       2316         75.2%          79.7%          52.4%      22.8%      24.8%
2425 <- 2324    97       2346         74.0%          79.3%          51.6%      22.4%      26.0%
```

**Il cancello 1 passa: 79.7% e 79.3%, sopra la soglia del 70%, su due campioni indipendenti.**

### 21.3 Ma la copertura mancante non è casuale

```
                       copertura media    squadre
2526  consolidate           85.1%           86
2526  neopromosse           35.3%           11
2425  consolidate           88.2%           83
2425  neopromosse           25.2%           14
```

Cinquanta-sessanta punti percentuali di distacco. Le neopromosse hanno giocato la N−1 in seconda
divisione, che Understat non copre. La concentrazione è persino più forte di così: fra le
"consolidate" sotto il 70% compaiono `FC_Cologne` (27.2%), `Hamburger_SV` (21.2%), `Paris_FC`
(41.8%), `Parma_Calcio_1913` (17.5%) — tutte neopromosse che il riconoscimento per nome non ha
associato allo slug Understat.

Il delta sarebbe quindi calcolabile all'85-88% dove il modello ha già una stagione intera di
storia, e al 25-35% dove non ha niente. **L'informazione arriva dove serve meno.**

### 21.4 Due ostacoli già visibili, uno dei quali è fatale al cancello 4

**(a) La cache della stagione corrente è in parte corrotta.** `Paris_Saint_Germain-2026.json`
contiene, nell'array `players`, **giocatori della RFPL russa** (Barinov, Gajic, Oblyakov,
Krugovoy) mentre l'array `dates` riporta correttamente le fixture del PSG in Ligue 1. La
corruzione è dentro il file: calendario giusto, rosa di un'altra entità. È il fallimento che
`understat_team_api.py` documenta ed emette come warning per le partite («hanno risposto con
partite di un'altra entità»), ma sui giocatori non c'è alcuna guardia e il risultato è finito su
disco con l'etichetta sbagliata. Altri file 2026 sono di squadre di seconda divisione
(`Malaga`, `Hull`, `Le_Mans`, `Racing_Santander`) che nel 2627 non sono nei Big Five.

Va corretto comunque, indipendentemente da Q3: è la stessa classe di difetto di Task 1.

**(b) Non esiste una fonte DATATA per la rosa, e il cancello 4 la richiede.** Verificato:

- l'array `players` di Understat è un **aggregato di fine stagione**: nessun campo con la data di
  una presenza (`id, player_name, games, time, goals, xG, assists, ... ` e nient'altro);
- l'array `dates` contiene le partite ma **nessuna formazione**;
- `squad_positions()` interroga l'endpoint roster di ESPN, che è lo **stato corrente**, senza
  storia;
- `player_context`, unica fonte datata, è uno snapshot singolo, e §19.6 mostra che per un quarto
  delle squadre è già vecchio di sette mesi.

Ne segue che «chi era in rosa in agosto della stagione N» non è ricostruibile per nessuna stagione
passata. Usare l'aggregato di fine stagione N per definire la rosa alla prima giornata significa
accreditare alla squadra i giocatori comprati a gennaio: è leakage, ed è esattamente ciò che il
cancello 4 vieta. L'alternativa forward-safe — «i giocatori già visti nelle giornate 1..k−1» — è
**vuota alla giornata 1** e quasi vuota alle giornate 2-3, che è precisamente la finestra in cui
Q3 cerca il suo segnale (+0.0579, 4.28σ).

### 21.5 Verdetto

Il cancello 1 **non chiude** il task: la soglia è superata e i dati esistono, già scaricati, in
forma migliore di quanto il prompt supponesse.

Ma i due fatti di §21.3 e §21.4(b) vanno messi accanto al costo dichiarato ("alto") prima di
proseguire ai cancelli 2 e 3: la copertura è concentrata sulle squadre che ne hanno meno bisogno,
e il cancello 4 è già visibile come bloccante con i dati in mano, non come rischio da valutare
dopo. Nessuno dei due è emerso dalla misura del cancello 1 in senso stretto — sono emersi dal
farla sul serio.

---

## 22. Confidenza dichiarata — l'incertezza si annuncia, non si insegue

Richiesta: mantenere le previsioni il più verosimili possibile e, quando i dati non bastano,
dichiararlo nell'etichetta di confidenza. Le due metà hanno storie opposte e vanno tenute
separate.

**Reagire** alla scarsità di dati — pesare di più la stagione in corso, regredire l'Elo al confine,
scontare le neopromosse — è la famiglia respinta cinque volte su cinque meccanismi indipendenti. I
parametri esistono e restano a valore neutro. **Dichiararla** non era mai stato fatto.

### 22.1 Perché `quality.score` non poteva fare da etichetta

Due ragioni, entrambe misurate:

1. **Alimenta la calibrazione.** Renderlo sensibile alla freschezza di stagione significa
   accendere `seasonQualityWeight`, cioè riaprire la famiglia respinta. Verificato nel test:
   `seasonQualityWeight = 0.5` cambia il lambda.
2. **È saturo** (§15, p05 = 0.995 sui Big Five). Alla prima giornata annunciava la stessa fiducia
   di aprile.

`confidence` è quindi un canale nuovo, calcolato **dopo** le probabilità e da quantità già
fissate. È la garanzia strutturale che dichiarare l'incertezza non possa cambiare la previsione
di cui si parla. Controllo: `ita.1` dal 2024-08-01 resta a **0.9865**, invariato.

### 22.2 Una mia misura ritrattata

Una prima misura del degrado per fase di stagione, su un campione da 75 gare, dava
`giorni 0-9 = 1.0435` contro `~0.990`, e su quel numero avevo scritto che «le soglie si scrivono
da sole». Il campione pieno lo smentisce:

```
campionati        n     log loss   err.std      coppe UEFA        n    log loss  err.std
giorni 0-9      233      0.9992    0.0274       giorni 0-9      288     1.0657   0.0216
giorni 10-24    174      1.0225    0.0276       giorni 10-24    505     1.0494   0.0151
giorni 50-99    828      0.9786    0.0146       giorni 50-99    380     1.0027   0.0199
giorni 100-199 1955      0.9926    0.0104       giorni 100-199  717     0.9736   0.0159
```

**Nei campionati la fase di stagione non produce un degrado misurabile**: le fasce stanno entro
un paio di errori standard l'una dall'altra. Ciò che è grande a inizio stagione è il *divario dal
mercato* (+0.0579, §3 del prompt sessione 3), non l'errore assoluto del modello. Due misure su
campioni piccoli e stride diversi possono dare 1.0435 e 0.9550 sulla stessa fascia: è la ragione
per cui R3 impone il confronto appaiato, e vale anche quando si misura una cosa sola.

**Nelle coppe il degrado c'è ed è netto**: 1.0657 contro 0.9736, oltre tre errori standard.

Conseguenza sul progetto: il fattore di stagione dichiara **da cosa è composta l'evidenza** — alla
prima giornata, per intero dalla stagione precedente — e non predice un errore più grande, che la
misura non sostiene. Il degrado misurato vero lo raccoglie il fattore xG.

### 22.3 Costruzione

Quattro fattori in (0,1], applicati a `quality.score` prendendone il **minimo** — un limite che
morde non si compensa con un'abbondanza altrove, e moltiplicarli farebbe crollare l'etichetta per
accumulo di penalità piccole invece che per un difetto reale:

| fattore | quando morde | valore |
|---|---|---|
| stagione | `seasonFreshness` < 0.15 / < 0.45 | 0.45 / 0.72 |
| xG | copertura < 50% | 0.75 + 0.5 × copertura |
| profondità | meno di 20 gare recenti fra le due squadre | 0.60 + 0.02 × gare |
| neopromosse | una o due squadre senza storia | 0.90 / 0.80 |

Ogni fattore che morde aggiunge una riga in `confidence.limits` con il motivo in chiaro:
l'interfaccia la mostra sopra il dettaglio della previsione, non solo nel tooltip del badge. Una
previsione che si dichiara poco affidabile senza dire di cosa manca è un'etichetta, non
un'informazione.

I valori non sono tarati su un esito: non esiste un osservabile «questa previsione era
affidabile» contro cui tararli.

### 22.4 Validazione: l'etichetta è predittiva, 4.23σ

Non tarabile non vuol dire non falsificabile. Se le gare dichiarate affidabili non sono davvero
previste meglio, l'etichetta è decorazione. Il confronto non è circolare: la confidenza non entra
in nessuna previsione, quindi le probabilità confrontate sono identiche nelle tre fasce.

`npm run diagnose:confidence`, 8141 gare dal 2023-08-01:

```
                 tutte              campionati            coppe UEFA
etichetta    n   quota  log loss    n   quota  log loss    n   quota  log loss
Alta      5384  66.1%   0.9905    4563  87.9%   0.9903    821  27.9%   0.9915
Media     1710  21.0%   1.0252     324   6.2%   0.9940   1386  47.0%   1.0325
Bassa     1047  12.9%   1.0369     307   5.9%   1.0162    740  25.1%   1.0454

Alta vs non-Alta: 0.0392 ± 0.0093  ->  4.23 sigma
```

**Monotona in tutti e tre i gruppi.** La separazione fra Alta e non-Alta è più grande di quasi
tutti gli effetti respinti in tre sessioni — con la differenza che questa non è una modifica alle
previsioni, quindi non ha un holdout da superare: è una descrizione verificabile di ciò che il
modello ha in mano, e la verifica la supera.

La distribuzione è quella che ci si aspetta: nei campionati l'88% delle gare resta "Alta", nelle
coppe solo il 28%.

### 22.5 Cosa questo non risolve

Il divario dal mercato a inizio stagione resta +0.0579. Dichiarare l'incertezza etichetta
correttamente il buco, non lo riempie — e §3 stabilisce che il buco esiste, perché il mercato in
quella fascia prevede meglio della propria media stagionale. Questo è il valore che §4 del prompt
chiamava «onestà dell'incertezza», ed è ora l'unico dei tre candidati residui a essere stato
realizzato e misurato.

---

## 23. Tre identità di club spezzate fra coppe e campionato — **corrette, +0.0145 in Champions**

Trovate mentre si indagava un'altra cosa: perché la copertura xG delle coppe è 0%. Quella domanda
ha due risposte — l'xG vero è un limite di fonte (viene da Understat, che copre solo i Big Five),
mentre tiri e tiri in porta sono un buco della pipeline (ESPN li ha al 100% per `uefa.champions`,
verificato dal vivo, ma `update_uefa_data.fetch_europe_then_espn` interroga ESPN solo quando l'API
UEFA fallisce: è un `or` dove servirebbe un `and`). Il riempimento di tiri e tiri in porta resta da
fare, ~379 richieste. Questa sezione è quello che è saltato fuori strada facendo, ed è risultato
valere di più.

### 23.1 Il difetto

Tre club esistevano nel dataset come **due squadre diverse**, una per le coppe e una per il
campionato, con zero sovrapposizione:

| club | nome nei campionati | nome nelle coppe |
|---|---|---|
| Atlético Madrid | `Atletico Madrid` — 116 gare | `Atleti` — 36 gare |
| Borussia Dortmund | `Dortmund` — 102 gare | `B. Dortmund` — 37 gare |
| Paris Saint-Germain | `PSG` — 103 gare | `Paris` — 46 gare |

Il terzo è il peggiore, perché non è solo uno split ma anche una **collisione**: `Paris` conteneva
le 46 gare europee del PSG **più le 35 di Ligue 1 del Paris FC**, club diverso promosso nel
2025-26 e presente nel dataset a pieno titolo. Nelle previsioni europee il PSG era quindi una
chimera di due squadre, mentre il PSG vero restava con 103 gare domestiche e zero europee.

L'origine è l'API UEFA, che usa grafie proprie (`Atleti`, `B. Dortmund`, `Paris`) mai dichiarate
in `TEAM_ALIASES`.

### 23.2 Perché nessuna misura di tre sessioni l'aveva visto

Per una previsione domestica `predictFromMatches` filtra via le coppe, quindi `Atletico Madrid`,
`Dortmund` e `PSG` erano intatti e completi. **Il difetto viveva solo nelle previsioni europee**,
dove `crossCompetition = true` e tutte le competizioni entrano nello stato.

Lì il modello aveva due Atlético: uno domestico, forte, costruito su 116 gare di Liga; e uno
europeo che partiva da `league_strength` = 1500 (le righe di coppa portano tutte 1500) e non
vedeva mai un risultato di campionato. Quando prevedeva l'Atlético in Champions usava il secondo.

Nemmeno i contratti di identità di Task 1 potevano vederlo: contano le identità **dentro una lega
e per stagione**, e un nome che compare solo nelle coppe non gonfia nessun conteggio di lega. Né
collide per grafia con la controparte domestica, perché le parole sono diverse.

### 23.3 Correzione

`Atleti` e `B. Dortmund` sono entrati in `TEAM_ALIASES` come varianti globali. `Paris` **non
poteva**: fuori dalle coppe indica il Paris FC, e un alias globale avrebbe fuso due club distinti
— il difetto opposto e più grave. È risolto in `update_uefa_data.UEFA_TEAM_OVERRIDES`, limitato
alla fonte, con una guardia in `repair_dataset_identities.py` che rifiuta la rinomina se il nome
di destinazione compare già in una riga di coppa (cioè se i due nomi convivono in Europa e sono
quindi club distinti).

Dataset riparato con lo strumento di Task 1: **119 nomi riscritti, 0 righe rifuse** — nessun
duplicato creato — e i conteggi di identità per lega invariati.

### 23.4 Quanto vale

`scripts/diag_dataset_ab.mjs` con il nuovo flag `--include-europe`, confronto appaiato per `id`
fra dataset vecchio e nuovo, 8141 gare dal 2023-08-01:

```
log loss VECCHIO : 1.0037        differenza appaiata : +0.0015 ± 0.0005
log loss NUOVO   : 1.0023        IC 95% bootstrap    : [0.0006, 0.0024]
gare toccate     : 2354/8141 (28.9%)     su quelle: +0.0050 ± 0.0016

per competizione
  ucl   812 gare   +0.0145 ± 0.0046   697 toccate
  uecl 1352 gare   +0.0001            852 toccate
  uel   783 gare   +0.0002            680 toccate
  eng.1/esp.1/fra.1/ger.1/ita.1       ~0, 0-54 toccate
```

**+0.0145 di log loss in Champions League.** Per contesto: il divario totale dal mercato è
+0.0214, e nessuno dei dieci meccanismi provati in tre sessioni ha mai superato +0.002. È il
guadagno più grande mai misurato in questo progetto, e conferma la regola già stabilita — le
uniche modifiche che migliorano le previsioni sono correzioni di dati e definizioni.

L'effetto è nullo su `uel`/`uecl` perché i tre club interessati giocano in Champions, e nullo sui
campionati perché lì le coppe erano già filtrate. Riferimenti aggiornati dal 2023-08-01:
`ita.1` 0.9886, `ucl` 0.9936, `uel` 1.0197, `uecl` 1.0459.

### 23.5 La rete, e un limite dichiarato

`tests/test_dataset_identity_contract.py` guadagna tre controlli, tutti verificati per mutazione
rimettendo il dataset pre-correzione (falliscono tutti e tre, poi tornano verdi):

| controllo | cosa intercetta |
|---|---|
| `normalize_team()` è l'identità su ogni nome del dataset | qualunque alias dichiarato ma sopravvissuto nei dati |
| nessun nome di sola coppa ha le parole contenute in un nome domestico | `B. Dortmund` ~ `Dortmund` |
| gli override di fonte UEFA non sopravvivono nelle righe di coppa | `Paris` |

**Limite da non nascondere**: il secondo controllo **non** avrebbe trovato `Atleti`, perché
"atleti" non è contenuto in "atletico madrid" — sono parole diverse, non una abbreviazione. Quel
caso è coperto solo dal primo controllo, che però protegge dalle regressioni e non dalla scoperta:
scatta soltanto dopo che l'alias è stato dichiarato.

Non esiste, con i dati attuali, una regola generale che scopra un caso come `Atleti`: le righe di
coppa non portano il codice paese (è presente solo sulle fixture future), quindi non si può
chiedere «questo club di un paese Big Five ha anche righe domestiche?». La procedura che l'ha
trovato resta manuale: elencare le squadre con molte gare domestiche e zero europee, e controllare
quali di quelle hanno certamente giocato in Europa. Sul dataset attuale sono 23, e le tre
anomalie erano lì dentro.

---

## 24. La schedina non trovava le quote — due difetti, nessuno dei quali nell'API

Sintomo riportato: la generazione della schedina dice di non trovare le quote anche con una
chiave valida di the-odds-api.com. L'integrazione non c'entrava.

### 24.1 Chiedeva le quote del turno sbagliato

`matchdays.js` calcola `firstUpcoming` (riga 160) ma **non lo restituiva**: le chiavi dell'oggetto
erano `competition, season, teams, matchdays, defaultRound, inferred`. `schedina.js` lo legge come
`calendar.firstUpcoming`, quindi valeva sempre `undefined` e il fallback cadeva su
`matchdays[0]` — il **primo turno della stagione**. Il 28/08/2026:

```
lega    turno chiesto        date        gia giocate
eng.1        1          21-24 agosto        10/10
esp.1        1          15-19 agosto         6/6
ita.1        1          22-24 agosto        10/10
fra.1        1          21-23 agosto         9/9
ger.1        1          28-30 agosto         0/9
```

Un'API di quote espone solo eventi futuri: per quattro leghe su cinque non poteva trovare nulla,
perché quelle partite erano finite da 4 a 13 giorni. L'errore risultante — "quote non trovate" —
puntava verso la chiave o il servizio, cioè nella direzione sbagliata.

La pagina principale non ne risentiva perché usa `defaultRound`, che era restituito e valeva
correttamente 2.

### 24.2 Costruiva giocate su partite gia' concluse

Un turno non e' un blocco atomico: la giornata 3 di Liga 2026-27 va dal 25 al 29 agosto, e al
momento della generazione 4 delle sue 6 gare erano finite. La schedina costruiva candidati su
tutte e sei — quindi poteva proporre una scommessa su una partita del giorno prima — e le contava
nel minimo di selezioni richieste.

`upcomingFixtures()` in `schedina.js` scarta il concluso e il passato. Il flag `completed` da solo
non basta: una gara di stamattina puo' non essere ancora stata ingerita dalla pipeline, e la data
e' la seconda rete — la stessa regola che segue un'API di quote, che smette di esporre un evento
quando comincia. Gli errori dicono ora il conteggio: «Il turno 3 ha 2 partite ancora da giocare
(4 gia' concluse)».

`tests/schedina-matchday.test.js`, verificato per mutazione su entrambi i difetti.

---

## 25. Due regressioni della pipeline, intercettate dai contratti

Il dataset e' stato rigenerato il 28/08/2026 alle 09:54. Le tre identita' ricomposte in §23 sono
**sopravvissute**: non sono tornate perche' la correzione era nella pipeline e non solo nei dati.
La rigenerazione ha pero' introdotto due difetti nuovi, entrambi fermati dai contratti esistenti.

### 25.1 `Malaga` / `Málaga`

`esp.1 2627` con 21 identita' per un campionato da 20. E' la collisione di sola grafia che
`resolve_spelling_collisions()` sa risolvere, riparata con 2 nomi riscritti e 2 righe rifuse.

**Tornera' a ogni rigenerazione**: la fusione per fold vive in `repair_dataset_identities.py`, non
nella pipeline, ed e' un'operazione sull'intero dataset (serve vedere tutti i nomi per scegliere
la grafia vincente) quindi non e' esprimibile come `normalize_team()` di un nome solo. Finche'
resta fuori dalla pipeline, il contratto la intercetta ma qualcuno deve eseguire la riparazione.

### 25.2 `lineup_strength` costante a 0.92 su tutte e 100 le squadre

Il contratto di Task 13 ha rilevato mediana 0.92 invece di 1.0. Non era una distribuzione
sbilanciata: `min = mediana = max = 0.92`, cioe' **il minimo del clamp**, per ogni squadra.

Causa, in `compute_lineup_strength()`:

```python
lineup_strength = compute_lineup_strength(lineup, players, reliability)
```

`lineup` arriva da `probable_lineup()`, che passa da `rounded_player()` — la funzione che
**aggiunge** il campo `impact`. `players` e' la lista grezza degli aggregati, che `impact` non ce
l'ha. `impact_of()` aveva un ripiego sui minuti, motivato in un commento con «restano
confrontabili fra i due undici perche' il rapporto li normalizza». Non li normalizza: i due lati
del rapporto arrivano da percorsi diversi. Il numeratore sommava `impact` (~10-20 a giocatore), il
denominatore `minuti` (~180-270). Rapporto ~0.06 per ogni squadra, e
`clamp(1 + 0.6*(0.06-1), 0.92, 1.07)` = **0.92**, sempre.

Verificato in isolamento, prima e dopo:

```
                                  prima     dopo
lineup arrotondato / rosa grezza   0.92      1.00     <- come chiama build_player_context
lineup arrotondato / rosa arrot.   1.00      1.00
```

Correzione: `impact_of()` **ricalcola** con `player_score()` invece di sostituire i minuti, così
la funzione e' indifferente alla forma dei dizionari che riceve. `recompute_lineup_strength.py`
ha ricostruito il campo nel dataset:

```
PRIMA  n=100  min 0.9200  mediana 0.9200  max 0.9200   sotto 1: 100  sopra 1:  0
DOPO   n=100  min 0.9200  mediana 1.0000  max 1.0454   sotto 1:  34  sopra 1: 18
```

**Impatto sulle previsioni: nullo.** Q1 ha scollegato `teamContext` dalla produzione e nessun
backtest lo ha mai passato, quindi era un campo che oggi nessuno consuma. Il difetto era comunque
reale, e sarebbe stato attivo il giorno in cui l'opzione (b) di Q1 venisse ripresa.

`tests/test_lineup_strength_contract.py` guadagna due controlli sulla FUNZIONE e non sul dato: il
risultato non deve dipendere dalla forma dei dizionari (le quattro combinazioni grezzo/arrotondato
devono coincidere entro 1e-3) e un undici probabile piu' debole deve abbassare il fattore. Il
primo, con il ripiego rimesso, fallisce con uno scarto di 0.15 e riproduce l'esatto 0.92.

I contratti di distribuzione avevano intercettato il difetto **dopo** che il dato sbagliato era
gia' nel dataset; questi lo intercettano nella funzione che lo produce.

### 25.3 La fusione delle grafie è entrata nella pipeline

`resolve_spelling_collisions()` è stata spostata da `repair_dataset_identities.py` a
`update_europe_data.py`, e la pipeline la applica **prima di `compute_elo()`**: applicarla dopo
unirebbe i nomi lasciando l'Elo e il team_context calcolati sulle identità spezzate, cioè
correggerebbe l'etichetta e non il dato. Lo strumento di riparazione ora la importa invece di
ridefinirla, così i due percorsi non possono divergere.

`tests/test_team_name_normalization.py` verifica tre cose: che lo strumento importi esattamente
la funzione della pipeline (non una copia), che nel sorgente la fusione preceda `compute_elo`, e
il criterio di scelta della grafia vincente. Il tie-break sulla lunghezza vale solo fra grafie con
lo **stesso fold**: `Oviedo`/`Real Oviedo` hanno fold diversi e restano competenza di
`TEAM_ALIASES`, perché distinguerli richiede conoscenze di calcio e non una regola meccanica.

Il catalogo completo dei difetti arrivati in produzione, con il pattern che li accomuna, è in
`MISTAKES.md`.

---

## 26. La schedina si generava e non si vedeva — due difetti nell'interfaccia

Segnalazione: per la Serie A la schedina non compare, e le quote sui marcatori si trovano solo per
7 partite su 10.

### 26.1 Le selezioni finivano dentro un `<input>`

`schedina.html` aveva **due elementi con `id="schedina-legs"`**: l'`<input type="number">` del
campo «Numero di partite» e il `<div>` dei risultati. `getElementById()` restituisce il primo in
ordine di documento, quindi `renderSlip()` scriveva le selezioni dentro l'input, che non
renderizza figli.

Nessuna eccezione, stato verde «Fatto.», sezione visibile e vuota. Le quote di mercato erano state
abbinate a **10 partite su 10** — visibile dal fatto che la nota «quote trovate per N su M»
compare solo quando `matched < total` ed era assente — quindi l'unica parte che funzionava era
quella sospettata.

Il contenitore è ora `schedina-selections`. `tests/dom-contract.test.js` verifica su tutte e
quattro le pagine che non ci siano id duplicati e che ogni id cercato con `$("...")` esista.

### 26.2 Due matcher diversi per le stesse partite

Le quote sui marcatori si fermavano a 7/10 perché le due strade abbinavano i nomi in modo diverso:

| percorso | criterio |
|---|---|
| `matchOddsToFixtures` (1X2) | `namesMatch()` — tollera il contenimento ("Inter" / "Inter Milan") |
| `collectPlayerOdds` (marcatori) | uguaglianza esatta fra nomi normalizzati |

Sulle stesse fixture il primo trovava 10, il secondo 7. La differenza si leggeva come una lacuna
del bookmaker mentre era un'incoerenza interna. Le due strade interrogavano anche regioni diverse
— `eu` per l'1X2, `us` per i marcatori — senza che nulla lo dichiarasse.

Ora usano lo stesso matcher, e il resoconto distingue le due cause, che hanno rimedi opposti:
«3 non abbinate al catalogo eventi» è un problema di nomi o date nostro, «3 senza mercato
marcatori sui bookmaker eu,us» è una scelta del bookmaker e non c'è niente da correggere.

Nota sulla quota: the-odds-api conta una richiesta per ogni combinazione mercato × regione.
Passare da una regione a due **raddoppia** il costo per evento, e il piano gratuito è di 500
richieste al mese. `PLAYER_PROP_REGIONS` è esportata per poterla riportare a una sola regione.

### 26.3 La fusione delle grafie ora sta su entrambi gli scrittori

Dopo averla messa in `update_europe_data.main()` (§25.3), una rigenerazione ha riportato lo split
`Malaga`/`Málaga`. La causa più probabile è temporale — Python carica il modulo all'avvio del
processo, e una run iniziata prima della modifica scrive con il codice vecchio anche se termina
dopo — ma la lezione è indipendente: `enrich_competitions_players.py` è l'**ultimo** a scrivere
`data/matches.json`, ed è un processo separato. La fusione è ora applicata anche lì, sui nomi
delle partite, delle fixture, di `teams` e delle chiavi di `team_context`/`player_context`.

È il difetto 7 di `MISTAKES.md` nella sua forma generale: **la correzione deve stare su ogni
percorso che scrive**, non solo su quello che si aveva in mente.
