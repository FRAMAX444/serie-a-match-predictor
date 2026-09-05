# PROMPT — Sessione 4: dal modello al prezzo

> Continuazione di `BRIEF-v2.md`, `PROMPT-sessione-2.md` e `PROMPT-sessione-3.md`. Questo
> documento ha precedenza su tutti e tre. Leggere §0 prima di qualsiasi altra cosa: contiene una
> misura nuova che chiude la fase di ottimizzazione dell'accuratezza e sposta l'asse del lavoro.

Tutti i numeri di questo documento si riproducono con un solo comando, deterministico e senza
rete:

```bash
node scripts/diag_market_execution.mjs            # ~75 s, tutte le sezioni
node scripts/diag_market_execution.mjs --only prezzo   # ~1 s, la parte che non usa il modello
```

Dataset: `data/matches.json`, 5347 gare dei Big Five dal 2023-08-01 con quote di chiusura
complete (media di mercato **e** miglior prezzo). Otto righe sono escluse perche' il miglior
prezzo e' incoerente (overround fuori da `[0.90, 1.15]`: sono errori della fonte, non
arbitraggi).

Verifica di continuita' con §27 di `docs/misure-riferimento.md`, fatta prima di procedere: sulla
stessa finestra (dal 2024-08-01) il divario appaiato modello-mercato misura qui **+0.0227 ±
0.0030 su 3603 gare (7.5σ)** contro **+0.0231 ± 0.0030 su 3551 (7.7σ)** del riferimento. Le misure
sono confrontabili; la differenza e' il dataset rigenerato dopo il 28/08.

---

## 0. La misura che chiude la fase di accuratezza

Due sessioni hanno chiesto **«quanto siamo indietro al mercato?»**. Nessuna ha chiesto **«il
modello aggiunge qualcosa al mercato?»**, che e' una domanda diversa e l'unica che decide se
esiste denaro da fare. Un previsore puo' essere peggiore di un altro e contenere comunque
informazione che l'altro non ha: e' esattamente il caso in cui la miscela dei due batte entrambi.

Il test e' il pool logaritmico. Si costruisce

```
p ∝ p_mercato^w · p_modello^(1−w)
```

si stima `w` sul training (fino al 2025-05-31) e si legge sull'holdout (dal 2025-07-08), che non
e' mai stato usato per stimare nulla. Se l'ottimo e' `w = 1`, il modello non contiene niente che
il mercato non abbia gia'.

```
  w sul mercato | logLoss training | logLoss holdout
      0.50      |      0.9682      |     0.9815
      0.70      |      0.9628      |     0.9781
      0.90      |      0.9588      |     0.9761
      1.00      |      0.9574      |     0.9755

  w ottimo sul training: 1.000
  guadagno sull'holdout rispetto al solo mercato: 0.00000 ± 0.00000
```

**L'ottimo e' `w = 1.000`, e non e' un ottimo di frontiera raggiunto per poco: la funzione e'
monotona su tutto l'intervallo, su entrambe le finestre.** Lo stesso test sull'Over/Under 2.5 da'
lo stesso risultato, `w = 1.000` su 5245 gare.

Il modello non ha informazione ortogonale alla linea di chiusura. Non e' «meno accurato del
mercato»: e' **contenuto** nel mercato.

### 0.1 Le due conseguenze, ed entrambe sono decisive

**Prima.** Il criterio di arresto pre-registrato in §4 del prompt sessione 3 — *«se Q3 fallisce
sull'holdout, la fase di ottimizzazione dell'accuratezza si chiude»* — e' **soddisfatto per una
via indipendente da Q3**. Un miglioramento del log loss del modello non e' incassabile finche'
`w = 1`, qualunque sia la sua ampiezza. La fase si chiude, e non perche' un'altra ipotesi sia
stata respinta: perche' la sua premessa e' falsificata.

**Seconda, e conta di piu'.** §27.3 aveva concluso, per ragionamento, che *«il disaccordo con il
mercato e' l'errore del modello, non un'opportunita'»*. Questa e' la stessa frase, misurata in
denaro:

```
soglia |     n | CLV medio       | sigma | ROI a quota d'apertura
   0%  |  5656 |   0.14% ± 0.12% |  1.24 |  -16.75% ± 2.20%
   5%  |  4236 |   0.20% ± 0.14% |  1.42 |  -19.27% ± 2.62%
  10%  |  3191 |   0.22% ± 0.17% |  1.28 |  -20.47% ± 3.15%

riferimento — CLV di una selezione presa a caso: 0.033% ± 0.060%
```

Due letture, entrambe da tenere:

1. **Non c'e' CLV.** Puntando all'apertura dove il modello vede valore, la chiusura ci da'
   ragione dello 0.14% ± 0.12% — indistinguibile dal caso, e indistinguibile dallo 0.033% di una
   selezione presa a caso. Il *Closing Line Value* e' il solo test che distingue un vantaggio
   reale dalla fortuna, e il modello lo fallisce.
2. **Piu' «valore» dichiara, peggio va.** Il ROI passa da −16.8% a −20.5% man mano che la soglia
   sale. Non e' rumore intorno a una media negativa: e' monotono, ed e' la firma della selezione
   avversa. Il filtro «punta dove vedo il 10% di valore» seleziona per costruzione le gare su cui
   il modello sbaglia di piu'.

Il modello perde anche contro la linea di **apertura** — +0.0254 ± 0.0024 (10.6σ) — e lo fa pur
prevedendo con `cutoffDate` alla data della gara, cioe' vedendo risultati che chi ha fissato
l'apertura non aveva. Non esiste nemmeno una finestra temporale in cui il modello sia davanti.

> **Da qui in avanti, nessun task di questo progetto puo' avere come criterio di successo il
> log loss del modello sull'1X2 o sull'Over/Under.** Non e' un divieto ideologico: e' che quel
> criterio e' stato misurato come non convertibile in denaro.

---

## 1. Dove sono i soldi: quattro numeri

### 1.1 Il prezzo vale 4.36 punti percentuali per gamba. Il modello vale zero.

```
1X2 chiusura, quota media      n=5347  media=1.05029  mediana=1.0472  sotto 1.000:  0.00%
1X2 chiusura, miglior quota    n=5347  media=1.00668  mediana=1.0064  sotto 1.000: 33.05%
```

Il margine del banco sulla **media** dei book e' il 5.03%. Sul **massimo** fra i book tracciati e'
lo 0.67%. Il divario e' **4.36 punti percentuali per singola giocata** — duecento volte il
guadagno di log loss che due sessioni di lavoro sul modello hanno prodotto, che e' zero.

Un terzo delle gare (33.05%) ha un miglior prezzo con overround **sotto 1.000**: alla chiusura, fra
i book tracciati, i tre esiti insieme costavano meno di quanto rendessero.

**Questo numero e' un limite superiore, non un'esecuzione.** `MaxC` di Football-Data e' il massimo
fra ~25 book, rilevati «alla chiusura» ma non necessariamente nello stesso istante, molti dei
quali non accettano un residente italiano. Va letto come *il tetto di cio' che l'esecuzione puo'
valere*, e la sezione §3 T1 esiste per misurare quanto se ne prende davvero.

La tendenza per stagione conta piu' della media, e va nella direzione sbagliata:

```
  2324  media=1.0433  migliore=0.9945  divario=4.88pp
  2425  media=1.0457  migliore=1.0017  divario=4.40pp
  2526  media=1.0613  migliore=1.0230  divario=3.84pp
  2627  media=1.0612  migliore=1.0239  divario=3.72pp
```

I book stanno alzando il margine medio (da 4.33% a 6.13%) e stringendo la coda alta. Il divario
resta grande ma si e' ridotto di un quarto in tre stagioni. Qualunque stima fatta sulla media
delle tre stagioni **sovrastima il regime attuale**: usare la riga `2526`.

La traduzione diretta in denaro, senza alcun modello — cambia solo *dove* si compra lo stesso
esito:

```
  favorito di mercato @ quota media      n=5347  ROI=  -0.49% ± 1.31%  (-0.37σ)
  favorito di mercato @ miglior quota    n=5347  ROI=   2.97% ± 1.36%  ( 2.18σ)
  sfavorito piu' lungo @ miglior quota   n=5347  ROI=  -8.76% ± 2.80%  (-3.13σ)

    2324  ROI=  5.79% ± 2.40%   2425  ROI= 2.28% ± 2.36%   2526  ROI= 0.66% ± 2.38%
```

**Due sigma su tre stagioni non sono una prova, e la tendenza per stagione e' discendente.** La
lettura difendibile e' che l'esecuzione porta la giocata dal −5% strutturale a **circa zero**, non
che la porti in positivo. Chi legge quel +2.97% come una strategia sta facendo l'errore che §9.4
ha gia' fatto una volta in questo progetto.

### 1.2 La multipla compone il margine e non compone il vantaggio

Al regime di prezzo attuale (stagione 2526, 1847 gare), con previsioni **perfette** e nessun
errore di modello, il valore atteso di una multipla e' solo una funzione dell'overround per gamba:

```
quota di divario catturata:       0%       40%      60%      80%     100%
overround effettivo per gamba: 1.0613   1.0455   1.0379   1.0304   1.0230

EV con  1 gamba:                -5.8%    -4.4%    -3.6%    -2.9%    -2.2%
EV con  3 gambe:               -16.3%   -12.5%   -10.6%    -8.6%    -6.6%
EV con  5 gambe:               -25.7%   -20.0%   -17.0%   -13.9%   -10.8%
EV con 10 gambe:               -44.8%   -35.9%   -31.0%   -25.9%   -20.3%
EV con 15 gambe:               -59.0%   -48.7%   -42.7%   -36.2%   -28.9%
```

**Ogni schedina che l'app genera oggi vale fra −16% e −45%**, a seconda del numero di gambe, e
nessuna scelta dell'ottimizzatore puo' cambiarlo: l'ottimizzatore sceglie *dentro* quella
superficie. La colonna `0%` e' il regime in cui l'app si trova adesso, perche' compra al prezzo
medio (§2, V1).

Il compounding non e' simmetrico. Il margine si compone; il vantaggio, se ce n'e' uno di segno
opposto, si compone anche lui — ma la varianza cresce molto piu' in fretta, e il tasso di crescita
del capitale crolla. Vedi §6.

### 1.3 La dipendenza dentro la partita e' l'unica cosa che il modello sa e il prezzo no

Questa e' la misura piu' importante del documento, ed e' costruita per essere immune al problema
di §0.

La matrice dei punteggi viene **riancorata alle marginali di mercato**: si risolvono
`lambda_casa`, `lambda_trasferta` e `rho` perche' la matrice riproduca esattamente `P(1)`, `P(X)`
e `P(Over 2.5)` della linea di chiusura de-vigata. Tre incognite, tre vincoli: il sistema e'
esattamente determinato e si risolve su **5346 gare su 5347**. Dopo il riancoraggio le marginali
del modello *sono* quelle del mercato — quindi la dimensione su cui il modello e' indietro
scompare — e cio' che resta del modello e' **soltanto la struttura di dipendenza fra i due
punteggi**.

Su tutte le 70 coppie di esiti derivabili da `deriveMarkets` di cui il punteggio finale decide
l'esito:

```
regressione senza intercetta:  log R_osservato = 0.9788 · log R_matrice   (e.s. 0.0217)
  dove R = P(A e B) / (P(A)·P(B)),  R = 1 significa indipendenza

  la matrice cattura il 97.9% della dipendenza in scala logaritmica
  errore relativo sulla congiunta: mediano 2.5%, massimo 20.2%
  logLoss medio sulla congiunta: matrice 0.5498 contro prodotto 0.5635
```

Il coefficiente e' a **0.98σ da 1**. Con marginali identiche a quelle del mercato, la struttura di
dipendenza del modello e' **calibrata**. Le coppie piu' forti, misurate:

```
coppia                   |    n | osservato | matrice | prodotto | R matr | R oss | err.rel
OVER25+NG                | 5346 |   0.109   |  0.116  |  0.244   | 0.474  | 0.446 |   6.1%
UNDER25+NG               | 5346 |   0.343   |  0.353  |  0.225   | 1.570  | 1.523 |   3.1%
OVER25+GG                | 5346 |   0.429   |  0.414  |  0.286   | 1.449  | 1.499 |   3.3%
X+OVER25                 | 5346 |   0.074   |  0.059  |  0.128   | 0.461  | 0.578 |  20.2%
```

Cioe': «Over 2.5 **e** entrambe segnano» succede il **42.9%** delle volte, contro il 28.6% che
darebbe il prodotto delle due probabilita' di mercato. Non e' un effetto piccolo — e' il 50% in
piu' — e la matrice lo prevede a meno del 3.3%.

**Questa e' l'unica dimensione misurata in cui il modello non e' dietro al mercato.** Ed e'
esattamente la dimensione che `slip-builder.js` ha vietato per costruzione: *«due selezioni della
stessa partita non vengono mai combinate»*.

Nota collaterale, che va nel registro: il `rho` implicito nella linea di mercato vale **−0.0817 di
media, −0.0846 di mediana**, contro il **−0.04** di produzione. Il mercato prezza circa il doppio
della correzione di Dixon-Coles che il modello applica. §16 aveva respinto `rho = −0.10`, ma **lo
aveva respinto sul log loss dell'1X2**, dove — come quella sezione stessa spiega — spostare 1.3pp
fra pareggio e altri esiti e' quasi neutro. Sulla **congiunta** non e' neutro affatto, ed e' la
seconda fonte indipendente (dopo la curva di affidabilita' di §14) a dire che −0.04 e' troppo
debole. Il rifiuto di §16 resta valido nel suo dominio e non si estende a questo.

### 1.4 Il de-vig proporzionale regala 2.25 punti percentuali al favorito

```
  proporzionale  logLoss 0.9633   favorito dichiarato 0.5246 contro osservato 0.5470 (2.25pp)
  Shin           logLoss 0.9625   favorito dichiarato 0.5317 contro osservato 0.5470 (1.54pp)
  guadagno di Shin sul proporzionale: 0.00086 ± 0.00026  (3.3σ)
```

`devigMarket()` in `backtest_vs_market.mjs` toglie il margine in proporzione, e il commento sopra
la funzione lo dichiara onestamente: *«non corregge il favourite-longshot bias»*. Il costo di
quella scelta e' ora misurato: il favorito dichiarato al 52.46% vince il 54.70% delle volte.
**Ogni probabilita' di mercato usata in questo progetto sottostima il favorito di 2.25pp.**

Conseguenze in due direzioni opposte, entrambe da dire:

- **Sulle misure**, il divario dal mercato e' stato calcolato contro un mercato *handicappato*: con
  Shin passa da +0.0276 a +0.0285. Il numero di riferimento e', se mai, una sottostima di quanto
  il modello sia indietro. Nessuna conclusione cambia di segno.
- **Sulle giocate**, e' esattamente il contrario: e' la ragione per cui il favorito al miglior
  prezzo rende +2.97% mentre l'EV calcolato con le probabilita' proporzionali dice −1.47%. Il
  «vantaggio» non e' nel modello, e' nell'errore di misura del mercato.

---

## 2. Le sei vulnerabilita', in ordine di grandezza misurata

Ogni voce ha la forma di `MISTAKES.md`: cosa, quanto vale, perche' nessun test l'ha vista, cosa
serve. Nessuna e' un difetto di implementazione — sono tutte scelte corrette per *misurare* il
modello e sbagliate per *giocare*.

### V1 — L'app compra al prezzo medio invece che al migliore · vale 4.36pp per gamba

**Cosa.** `averageOutcomeOdds()` in `schedina.js:253` fa la **media** dei prezzi di tutti i
bookmaker restituiti da the-odds-api, e il commento sopra la motiva: *«la media e' il consenso di
mercato: prendere il massimo sarebbe la quota migliore ottenibile, ma non e' un prezzo che esiste
ovunque e renderebbe ogni confronto ottimistico»*.

**Il ragionamento e' giusto per un benchmark e rovesciato per una giocata.** Non si scommette al
consenso: si scommette presso *un* book, e si sceglie quale. La media e' la stima corretta della
probabilita'; il massimo fra i book su cui si ha un conto e' il prezzo corretto. L'app usa un solo
numero per due ruoli che non coincidono.

**Quanto vale.** 4.36pp per gamba sul dataset intero, 3.84pp al regime attuale — che su una
multipla da 5 gambe e' la differenza fra −25.7% e −10.8% di EV. E' la voce piu' grande di tutto il
documento, di un ordine di grandezza.

**Perche' nessun test l'ha vista.** `tests/odds-matching.test.js` verifica che ogni selezione
prezzabile prenda un prezzo di mercato e che le derivazioni siano esatte. Con una risposta
simulata a piu' book, media e massimo sono entrambi numeri plausibili e nessuna asserzione li
distingue. E' la stessa forma del difetto 21 — due grandezze diverse trattate come la stessa — su
un confine diverso: li' quota equa contro quota di mercato, qui consenso contro prezzo.

**Cosa serve.** La risposta dell'API contiene gia' i prezzi **per singolo bookmaker**: sono
scaricati, mediati e buttati. Servono tre grandezze distinte per ogni esito — `consensus` (la
media, per la probabilita' e per ogni misura), `best` (il massimo sui soli book su cui si gioca
davvero, per l'EV) e `bookmaker` (dove si trova quel prezzo, altrimenti non e' azionabile) — piu'
un elenco di book configurabile in `settings.html`.

### V2 — La combo nella stessa partita e' vietata proprio dove il modello e' esatto · vale fino a +50%

**Cosa.** `slip-builder.js` prende al piu' una selezione per partita, e il README lo motiva:
*«moltiplicare come indipendenti due probabilita' correlate sovrastimerebbe la schedina»*. La
premessa e' vera e la conclusione non segue: il modello **non deve** moltiplicare come
indipendenti, perche' ha la matrice dei punteggi e la congiunta esatta e' una somma di celle. Il
divieto non evita l'errore, evita di guardare.

**Quanto vale.** Prezzando le due gambe come il **prodotto** delle due quote di mercato — cio' che
fa un banco che tratta le gambe come indipendenti — su 5347 gare:

```
combo              | @quota media                | @miglior quota              | R osservato
X+UNDER25          |   36.68% ±  4.41% (   8.3σ) |   50.04% ±  4.92% (  10.2σ) |  1.537
1+OVER25           |    0.15% ±  2.63% (   0.1σ) |    8.91% ±  2.90% (   3.1σ) |  1.177
2+OVER25           |   -1.11% ±  3.28% (  -0.3σ) |    8.92% ±  3.68% (   2.4σ) |  1.134
1+UNDER25          |  -32.00% ±  2.43% ( -13.2σ) |  -25.77% ±  2.69% (  -9.6σ) |  0.794
X+OVER25           |  -48.13% ±  2.54% ( -18.9σ) |  -43.47% ±  2.78% ( -15.6σ) |  0.538
```

Il pareggio e' quasi sempre 0-0 o 1-1, quindi «X e Under 2.5» e' molto piu' probabile del prodotto
delle sue due probabilita'. Il segno fortemente negativo delle coppie anticorrelate (X+Over25 a
−18.9σ) e' la controprova che il meccanismo e' reale e non un artefatto di campione.

**Onesta' obbligatoria: nessun banco maggiore prezza «X + Under 2.5» come prodotto.** E' la coppia
da manuale, e ogni motore di *bet builder* la conosce. Il numero non e' una strategia — e'
**il dimensionamento del termine che si sta ignorando**. Serve a stabilire che se il banco ne
recupera anche i tre quarti, quel che resta e' ancora piu' grande del margine:

| frazione della dipendenza recuperata dal banco | 0% | 25% | 50% | 75% | 100% |
|---|---|---|---|---|---|
| EV di X+U2.5 al miglior prezzo | +50.4% | +35.1% | +21.3% | +9.0% | −2.1% |
| EV di 1+Over2.5 al miglior prezzo | +8.5% | +4.1% | −0.0% | −4.0% | −7.8% |

E il progetto ha, misurato a 0.98σ da 1, **la stima calibrata di quel termine**. Non ha bisogno di
prevedere l'esito meglio del banco: gli basta prezzare la dipendenza meglio del banco, che e' un
requisito molto piu' debole e l'unico che le misure sostengono.

**Perche' nessun test l'ha vista.** `tests/slip-builder.test.js` verifica che l'ottimizzatore
rispetti il vincolo «al piu' una per partita»: il vincolo e' testato, la sua giustificazione mai.
Ed era corretta finche' i mercati combinati non venivano prezzati — cioe' finche' non si guardava.

**Cosa serve.** Un modulo che, data una partita, produca la congiunta esatta di ogni coppia di
esiti dalla matrice riancorata alle marginali di mercato, e la confronti con il prezzo che il
banco espone per quella combo. Il confronto e' fra due numeri sulla stessa scala e non richiede
che il modello batta nessuno.

### V3 — L'ottimizzatore massimizza la vincita, non il valore atteso

**Cosa.** L'obiettivo e' `Σ ln(quota) + 0.25 · Σ ln(affidabilita')` con vincolo
`Σ ln(probabilita') ≥ ln(sicurezza)`. Poiche' l'obiettivo premia solo la quota, la ricerca spinge
`Σ ln(p)` fino al bordo del vincolo, sempre. Il risultato e' *la massima vincita a una data
probabilita' di vittoria* — una preferenza legittima, e non il valore atteso.

`expectedReturn = combinedOdds × combinedProbability` viene **calcolato e mostrato**
(`slip-builder.js:362`) ma non entra in nessuna decisione. La schedina numero 1 e la numero 10
possono avere EV diversi e l'ordinamento non ne tiene conto.

**Quanto vale.** Sulla superficie attuale (tutte le combinazioni a EV negativo) l'effetto e'
piccolo: si sceglie fra perdite. Diventa la voce decisiva appena V1, V2 o V4 spostano una parte
della superficie sopra lo zero, perche' allora l'ordinamento per vincita e quello per EV
divergono, e il primo sceglie sistematicamente le combinazioni sbagliate.

**Perche' nessun test l'ha visto.** Il test verifica monotonia su probabilita' e quota e coerenza
dei totali. Con quote eque `EV = 1` per costruzione, quindi ogni schedina ha lo stesso EV e il
difetto e' invisibile in tutti gli scenari che il test costruisce.

**Cosa serve.** Un secondo criterio esplicito accanto al primo — *massima vincita a sicurezza
data* resta, e si affianca *massimo EV*, con un filtro `EV ≥ soglia` che possa non restituire
nulla. Una schedina a EV negativo va segnalata come tale, con il numero.

### V4 — Il modello di costo non conosce i bonus, che sono l'unico moltiplicatore strutturale

**Cosa.** Il mercato italiano della schedina ha una caratteristica che l'1X2 singolo non ha: il
**bonus multipla**, una percentuale sulla vincita che cresce con il numero di eventi, sopra una
quota minima per evento. E' contrattuale, pubblicato, ed e' l'unico termine del conto che **non
dipende da chi ha ragione sulla partita**.

L'app ha gia' il parametro che ci va vicino — `DEFAULT_MIN_LEG_ODDS = 1.20`, che e' proprio la
soglia tipica di quei regolamenti — ma per una ragione diversa (§«Quota minima per selezione» del
README) e senza sapere che esiste una scala di bonus a cui puntare.

**Quanto vale.** Il conto e' esatto. Con overround `m` per gamba e bonus `B` sulla vincita lorda:

```
EV = (1 + B) · ∏(1/m_i) − 1        ->   pareggio quando  B = m^N − 1
```

Bonus minimo perche' l'EV torni a zero, ai cinque regimi di esecuzione (stagione 2526):

```
gambe |  @media   @40%    @60%    @80%    @max
    3 |   19.5%   14.3%   11.8%    9.4%    7.1%
    5 |   34.6%   24.9%   20.4%   16.1%   12.0%
    8 |   61.0%   42.8%   34.6%   27.0%   20.0%
   10 |   81.3%   56.1%   45.0%   34.9%   25.5%
   15 |  144.1%   95.0%   74.6%   56.6%   40.7%
```

Un bonus applicato alla vincita **netta** invece che lorda alza la soglia del fattore `Q/(Q−1)`,
con `Q` la quota totale: su una multipla da 8.00 e' un +14% relativo, su una da 60.00 un +1.7%.

La lettura e' immediata e non ammette ottimismo: **al prezzo medio nessuna scala di bonus
realistica basta**, perche' servirebbe l'81% a dieci gambe. Al miglior prezzo la soglia scende al
25.5%, che e' dentro l'ordine di grandezza delle scale pubblicate. **Il bonus non e' un'alternativa
all'esecuzione: e' inutile senza.** Le due leve si moltiplicano, e V1 viene prima.

**Perche' nessun test l'ha visto.** Non e' un difetto del codice: e' un termine del problema che
il codice non rappresenta. La schedina non ha mai avuto un modello di costo, solo un
ottimizzatore.

**Cosa serve.** La scala di bonus del proprio operatore come **dato configurato**, non cablato:
`{ gambeMinime, quotaMinimaPerGamba, percentuale, suVincitaNetta }`. Da li' l'ottimizzatore puo'
fare la sola cosa sensata — cercare il numero di gambe che massimizza `EV(N)`, che con una scala
di bonus non e' piu' monotono decrescente in `N` ed e' l'unico punto in cui giocare piu' gambe
puo' essere razionale. **Il regolamento va letto sul sito dell'operatore e trascritto:
questo documento non contiene numeri di promozioni, perche' cambiano e verificarli non e'
possibile da qui.**

### V5 — Il de-vig proporzionale, usato per una decisione invece che per una misura

Descritto in §1.4. Vale 2.25pp sul favorito e 0.00086 ± 0.00026 di log loss (3.3σ). Sostituirlo
con Shin dove si prende una **decisione** (candidati della schedina, riancoraggio della matrice,
EV di una combo) e lasciarlo dov'e' per la **continuita' delle misure** — cambiarlo in
`backtest_vs_market.mjs` renderebbe non confrontabile ogni numero di `docs/misure-riferimento.md`.

**Perche' nessun test l'ha visto.** Il commento sopra `devigMarket()` dichiara il limite, quindi
non e' nemmeno un difetto nascosto: e' un limite noto che nessuno aveva quantificato perche'
serviva solo a misurare, e nel confronto appaiato l'errore e' quasi comune ai due bracci.

### V6 — Nessun dimensionamento della puntata, e la varianza della multipla e' enorme

**Cosa.** L'app produce dieci schedine e nessun importo. Non e' una mancanza cosmetica: con
vantaggi dell'ordine di pochi punti percentuali e quote a due o tre cifre, **la puntata corretta e'
il numero che decide se il capitale cresce o se salta**, molto prima della scelta delle gambe.

**Quanto vale.** §6 lo quantifica: una multipla da 10 gambe con +5% di EV giustifica lo 0.085% del
capitale e raddoppia in 33248 giocate. La stessa 1X2 singola con +5% giustifica il 5.6% e
raddoppia in 498.

**Cosa serve.** Kelly frazionario (un quarto e' lo standard prudente) calcolato sulla probabilita'
del modello, con l'avvertenza esplicita che se la probabilita' e' sopravvalutata Kelly sovrastima
in modo quadratico. E il **numero di giocate necessarie** perche' l'esito sia distinguibile dal
caso, accanto a ogni schedina: e' l'informazione che rende onesto tutto il resto.

---

## 3. Il piano — sei task con cancelli

L'ordine non e' negoziabile: **T1 precede tutto**, perche' T2, T3 e T4 hanno tutti la stessa
precondizione e senza il suo numero sono tre stime di qualcosa che non e' stato misurato.

### T1 — Misurare l'esecuzione vera · **cancello per T2, T3, T4**

Il 4.36pp e' un tetto derivato da un massimo su ~25 book non contemporanei. Il numero che serve e'
**quanto di quel divario si prende con i K conti che si hanno davvero**, ed e' misurabile a costo
zero: the-odds-api restituisce gia' i prezzi per singolo bookmaker, e `schedina.js` li media via.

1. In `averageOutcomeOdds()`, accanto alla media, raccogliere `{ best, bookmaker, count, spread }`.
2. Registrare per ogni turno, in un file di misura, i prezzi per book di ogni esito.
3. Dopo **almeno 8 turni**, misurare `(best_K − consensus) / (best_tutti − consensus)` per
   `K = 1, 3, 5, 8` book fra quelli su cui si puo' davvero giocare.

**Cancello, pre-registrato.** Se la cattura sui book realmente accessibili risulta **sotto il 40%
del divario** — cioe' sotto ~1.5pp per gamba al regime attuale — **T4 non si apre**: la tabella di
§2 V4 dice che nessuna scala di bonus realistica basta sotto quella soglia, e continuare
significherebbe costruire un ottimizzatore per una superficie che resta tutta negativa. T2 e T3 si
fanno comunque, perche' valgono anche da soli.

**Costo:** basso, ma richiede tempo di calendario (8 turni). Iniziare subito, in parallelo a T2.

### T2 — Separare il consenso dal prezzo · nessuna precondizione

Tre grandezze distinte per ogni esito, dove oggi ce n'e' una:

- `consensus` — la media, per la probabilita' implicita e per ogni misura. Non cambia.
- `best` — il massimo sui soli book configurati, per l'EV e per la quota mostrata.
- `bookmaker` — dove si trova quel prezzo. Una quota senza il nome del book non e' azionabile,
  ed e' esattamente il difetto 21 in forma nuova: un numero mostrato che non si puo' ottenere.

Elenco dei book in `settings.html`, come le altre preferenze. Vuoto = comportamento attuale.

**Verifica:** un test che, data una risposta con tre book a 2.00 / 2.10 / 2.20, produce
`consensus = 2.10` e `best = 2.20` con il nome giusto, e che con l'elenco vuoto `best = consensus`.
Il calcolo dell'EV deve usare `best` e la probabilita' `consensus`: **mescolarli e' il difetto 21**.

**Successo:** la schedina mostra quota, book e EV di ogni gamba, e la quota totale e' ottenibile
presso i book nominati.

### T3 — Il quaderno delle combo · precondizione: T1 avviato

Un modulo puro, sul modello di `slip-builder.js`, che per ogni partita:

1. riancora la matrice alle marginali di mercato de-vigate con Shin (la routine e' gia' in
   `scripts/diag_market_execution.mjs`, va promossa a `model.js` accanto a `scoreMatrix`);
2. calcola la congiunta esatta di ogni coppia di esiti che il banco combina;
3. la confronta con il prezzo della combo, e riporta `EV = P_congiunta × quota_combo`;
4. **dichiara** quando il banco non espone la combo o la rifiuta.

Il termine di dipendenza va **ridotto** prima dell'uso. La regressione dice `0.9788 ± 0.0217`, ma
l'errore massimo per coppia e' del 20.2% ed e' concentrato sulle coppie che coinvolgono il
pareggio (`X+OVER25`, `X+NG`). Il fattore prudenziale non e' pessimismo: e' che l'EV di una combo
e' lineare in `R` e un errore del 20% su `R` e' un errore del 20% sull'EV.

**Verifica:** `P(A e B)` dalla matrice deve coincidere con la frequenza osservata sul dataset entro
l'errore standard, coppia per coppia — cioe' la tabella di §1.3 diventa un test.

**Cancello, pre-registrato.** Raccogliere i prezzi combo reali di **almeno 200 combinazioni** e
confrontarli con la congiunta. Se la mediana di `quota_combo × P_congiunta` e' **sotto 0.98**, il
banco prezza la dipendenza meglio o quanto noi e **T3 si chiude come negativo**, con la sua voce
in `docs/misure-riferimento.md`. Se sta sopra **1.02**, si passa alla verifica prospettica con la
regola R15 di §4.

### T4 — L'EV nell'obiettivo, e la scala dei bonus · precondizione: T1 superato

1. `EV` come criterio di ordinamento accanto a «massima vincita», non al suo posto.
2. Filtro `EV ≥ soglia`, che puo' restituire zero schedine. **Restituire zero e' il
   comportamento corretto** quando nessuna combinazione supera la soglia: e' l'unica funzione che
   fa guadagnare l'utente in un turno senza occasioni.
3. La scala di bonus come dato configurato, e la ricerca del numero di gambe che massimizza
   `EV(N)` invece di prenderlo dall'utente.

**Verifica:** con una scala di bonus nulla, `EV(N)` deve essere monotona decrescente in `N` e il
risultato identico a oggi (R1: neutralita' esatta). Con una scala non nulla, l'ottimo in `N` deve
cadere dove il conto di §2 V4 dice.

### T5 — Shin dove si decide · nessuna precondizione

`shinDevig()` esiste gia' in `scripts/diag_market_execution.mjs`. Va promossa e usata nei
candidati della schedina, nel riancoraggio e nell'EV. **Non** in `backtest_vs_market.mjs` ne' in
`diag_market_dimensions.mjs`: li' romperebbe la confrontabilita' con `docs/misure-riferimento.md`,
e il guadagno e' di misura, non di decisione.

**Verifica:** su un mercato con overround 1.000 esatto, Shin deve restituire le probabilita'
proporzionali bit per bit (R1).

### T6 — Puntata e verifica · precondizione: T2

1. Kelly frazionario (default un quarto) accanto a ogni schedina, con il capitale come
   preferenza.
2. `slip-history.js` registra, per ogni gamba, **quota presa, book, ora, e quota di chiusura dello
   stesso esito**. Il CLV per gamba e' la sola misura che dica se la strategia funziona **prima**
   che il campione basti al ROI — §6 dice che al ROI servono decenni.

**Verifica:** su almeno 200 gambe, il CLV medio con il suo errore standard. E' il numero che
sostituisce «quante schedine abbiamo vinto».

---

## 4. Pre-registrazione (R15), scritta prima di guardare qualunque esito

R15 esiste perche' in questo progetto nove ipotesi su nove sono state respinte dopo essere
sembrate promettenti. Queste tre soglie sono fissate adesso, e la decisione in caso di fallimento
e' dichiarata adesso.

| # | ipotesi | misura | soglia di successo | decisione se fallisce |
|---|---|---|---|---|
| P1 | l'esecuzione su K conti reali cattura una parte utile del divario | `(best_K − consensus)/(best_tutti − consensus)` su ≥ 8 turni | **≥ 40%** | T4 non si apre; T2 resta perche' vale comunque |
| P2 | il banco prezza la dipendenza peggio della matrice | mediana di `quota_combo × P_congiunta` su ≥ 200 combo | **≥ 1.02** | T3 chiuso come negativo, voce in `misure-riferimento.md` |
| P3 | le gambe giocate hanno CLV positivo | CLV medio su ≥ 200 gambe reali | **≥ +1.0% a ≥ 2σ** | l'intera pista si chiude: senza CLV il ROI positivo e' fortuna |

**P3 e' la soglia che conta.** Le altre due misurano se un'opportunita' esiste; P3 misura se la si
sta incassando. Un ROI positivo con CLV nullo va trattato come rumore, per quanto grande sia — e'
la stessa disciplina con cui §17 ha respinto il bias arbitro nonostante 4.2σ.

**Regola sul numero di prove.** Ogni coppia di esiti provata e ogni segmento (lega, fascia di
quota, numero di gambe) e' una prova in piu'. Con 70 coppie, una casella a 2σ e' cio' che si
aspetta dal caso: vale qui la stessa avvertenza di §27.1, e le soglie sopra sono su misure
**dichiarate prima**, non sulla migliore trovata dopo.

---

## 5. Cosa NON fare

Sono i modi di perdere denaro che sembrano ragionevoli, e ognuno e' escluso da una misura di
questo documento o dei precedenti.

1. **Non filtrare le giocate col «valore» del modello.** −16.8% di ROI, che peggiora a −20.5%
   all'aumentare del valore dichiarato (§0.1). E' selezione avversa, non sfortuna.
2. **Non migliorare il log loss sperando che paghi.** `w = 1.000` su entrambe le finestre e su
   entrambi i mercati (§0). Finche' quel numero non cambia, un modello piu' accurato non e' un
   modello piu' redditizio.
3. **Non aggiungere parametri.** Dieci meccanismi provati, dieci respinti. La lista «Da non
   riaprire» di `PROMPT-sessione-3.md` §6 resta valida per intero, e §0 la rafforza.
4. **Non giocare le dieci schedine dello stesso turno.** Condividono le partite, quindi gli esiti:
   e' la stessa scommessa moltiplicata. Il README lo dice gia'; con l'EV in vista diventa un
   errore quantificato, non un'avvertenza.
5. **Non allungare la multipla per alzare la quota.** Ogni gamba moltiplica il margine (§1.2). Le
   gambe si aggiungono **solo** se una scala di bonus verificata rende `EV(N)` crescente in quel
   tratto, e mai oltre il suo massimo.
6. **Non leggere il +2.97% del favorito al miglior prezzo come una strategia.** 2.18σ su tre
   stagioni, con tendenza discendente (5.79% → 2.28% → 0.66%) e nessun CLV a sostegno. La lettura
   difendibile e' «l'esecuzione porta a circa zero».
7. **Non inseguire l'overround sotto 1.000 come arbitraggio.** Il 33.05% delle gare lo mostra sul
   massimo fra ~25 book, ma quei prezzi non sono contemporanei ne' tutti accessibili, e la voce
   e' esattamente la piu' esposta a limitazione del conto.
8. **Non trasformare lo storico delle schedine in addestramento.** Il README lo esclude gia' con
   l'argomento giusto: gli esiti delle partite sono gia' tutti nel modello.
9. **Non promettere un rendimento.** Il paragrafo «Limiti» del README resta vero parola per
   parola, e §6 spiega perche' anche un vantaggio reale sarebbe indistinguibile dal caso per anni.

---

## 6. Quanto vale, onestamente

### 6.1 Il tasso di crescita, non il ROI

Con vantaggio `EV−1` e quota `o`, Kelly da' `f* = (p·o − 1)/(o − 1)`:

```
struttura            quota  P(vince)   EV     f* Kelly   crescita/giocata   giocate per raddoppiare
singola 1X2           1.90   53.68%     2%      2.222%        2.22e-4            3117
singola 1X2           1.90   55.26%     5%      5.556%        1.39e-3              498
multipla 5 gambe      8.00   13.13%     5%      0.714%        1.76e-4            3936
multipla 5 gambe      8.00   14.37%    15%      2.143%        1.54e-3              449
multipla 10 gambe    60.00    1.75%     5%      0.085%        2.08e-5           33248
multipla 10 gambe    60.00    2.08%    25%      0.424%        4.91e-4            1412
```

**A parita' di vantaggio, la multipla cresce di un ordine di grandezza piu' lentamente della
singola.** Un +5% su dieci gambe giustifica lo 0.085% del capitale: su 1000 € sono 85 centesimi.
La multipla ha senso solo se un bonus porta il suo vantaggio a un multiplo di quello ottenibile
sulla singola — che e' precisamente il conto di §2 V4, e precisamente perche' T1 viene prima.

### 6.2 Quanto tempo serve per sapere se funziona

Numero di giocate perche' il ROI osservato stia a 2 errori standard da zero:

```
struttura            EV    dev.std   n per 2σ   anni a una giocata a settimana
singola 1X2           2%     0.95       8976              224
singola 1X2           5%     0.94       1428               36
multipla 5 gambe      5%     2.70      11676              292
multipla 5 gambe     15%     2.81       1401               35
multipla 10 gambe     5%     7.87      99036            2476
multipla 15 gambe    40%    23.62      13952              349
```

**Il ROI non e' una misura utilizzabile su questa scala.** Ecco perche' P3 di §4 e' sul CLV: il CLV
si misura per gamba invece che per schedina, ha varianza minuscola in confronto, e da' una
risposta in centinaia di giocate invece che in decenni.

### 6.3 Il conto onesto, messo tutto insieme

Tutte le righe sotto sono **ROI misurati** su 5347 gare, non stime composte. La sola cosa
interpolata e' la frazione di divario catturata, che e' precisamente cio' che T1 deve misurare.

```
puntata generica, quota media di mercato                     −5.8%   (aritmetica dell'overround)
solo il favorito, quota media                                −0.49% ± 1.31%   (−0.37σ)
solo il favorito, cattura 40% del divario                    +0.89% ± 1.33%   (+0.67σ)
solo il favorito, cattura 60% del divario                    +1.58% ± 1.34%   (+1.18σ)
solo il favorito, cattura 100% (il tetto, non l'esecuzione)  +2.97% ± 1.36%   (+2.18σ)
solo lo sfavorito piu' lungo, cattura 100%                   −8.76% ± 2.80%   (−3.13σ)
```

Tre cose vanno lette insieme, e la terza e' quella che conta:

1. **Il salto da −5.8% a −0.49% non lo fa il modello, lo fa il de-vig.** Restringersi al favorito
   raccoglie i 2.25pp che il de-vig proporzionale gli toglie (§1.4). Non e' una previsione: e'
   una proprieta' della scala dei prezzi, e vale senza sapere nulla della partita.
2. **Il salto da −0.49% a circa +1.6% lo fa l'esecuzione**, e la sua ampiezza e' esattamente la
   quantita' che T1 deve misurare invece di assumere.
3. **Nessuna di queste righe e' distinguibile da zero.** A cattura 60% il risultato e' 1.18σ, e la
   tendenza per stagione e' discendente. **La lettura difendibile e' «circa zero», non «positivo»**:
   e' la stessa disciplina con cui §9.4 fu ritirata e con cui §17 respinse un 4.2σ.

**Da un valore atteso circa nullo, un valore atteso positivo puo' venire solo da un termine che
non dipende da chi vince la partita**: la scala dei bonus (T4), le quote maggiorate, il rimborso
in caso di una gamba sbagliata, il termine di dipendenza su una combo (T3). Sono termini
contrattuali o combinatori — esatti, e si calcolano, non si prevedono.

Questa e' la risposta piu' precisa che i dati sostengono, ed e' piu' utile di quella che si
sperava. Non e' «il mercato e' imbattibile»: e' che il punto di attacco non e' la previsione,
il margine strutturale e' azzerabile con l'esecuzione, e i pochi punti percentuali che separano
dal segno positivo stanno tutti in voci che il progetto oggi non rappresenta — nessuna delle
quali richiede di indovinare un risultato.

---

## 7. Rischi e limiti, dichiarati

1. **Il miglior prezzo e' un limite superiore.** `MaxC` e' il massimo fra ~25 book non
   contemporanei, molti non accessibili da un residente italiano. T1 esiste per misurare la
   frazione reale, e nessun numero di §1.1 va usato come se fosse quella frazione.
2. **La limitazione del conto e' il vincolo che morde davvero.** Un book che si accorge di essere
   sistematicamente battuto sul prezzo riduce l'importo massimo, spesso a pochi euro. E' il motivo
   principale per cui questa strategia non scala oltre l'importo ricreativo, e va detto
   nell'interfaccia accanto a Kelly.
3. **Le promozioni cambiano senza preavviso.** La scala dei bonus va **letta dal regolamento
   dell'operatore e trascritta**, con la data. Un valore cablato che scade e' un prezzo sbagliato
   usato come vero — la stessa forma del difetto risolto da `odds-cache.js`.
4. **Il termine di dipendenza e' calibrato in media, non su ogni coppia.** Errore mediano 2.5%,
   massimo 20.2%, concentrato sulle coppie che coinvolgono il pareggio. Va ridotto
   prudenzialmente, e le coppie con `X` vanno trattate a parte.
5. **Le gare dello stesso turno sono indipendenti, ed e' verificato.** Varianza osservata contro
   varianza sotto indipendenza, 514 turni: Over 2.5 `0.988 ± 0.062`, vittoria casa `0.963 ±
   0.062`, favorito `0.939 ± 0.062`. Il prodotto delle probabilita' **fra partite diverse** e'
   corretto; il problema e' solo dentro la stessa partita. Nessun rifacimento del calcolo della
   sicurezza e' necessario.
6. **Solo operatori con concessione ADM.** Nessuna delle misure di questo documento e' un motivo
   per usarne altri, e la sezione bonus va verificata sul regolamento italiano dell'operatore.
7. **Niente di tutto questo e' una promessa di rendimento.** §6.2 dice che, anche con un vantaggio
   reale, il campione necessario per dimostrarlo e' fuori dalla portata di un giocatore.

---

## Appendice A — riproduzione

```bash
node scripts/diag_market_execution.mjs                     # tutto, ~75 s
node scripts/diag_market_execution.mjs --only prezzo       # §1.1, §1.4 — ~1 s
node scripts/diag_market_execution.mjs --only multipla     # §1.2 — ~1 s
node scripts/diag_market_execution.mjs --only combo        # §2 V2 — ~1 s
node scripts/diag_market_execution.mjs --only dipendenza   # §1.3 — ~15 s
node scripts/diag_market_execution.mjs --only miscela      # §0 — ~70 s
node scripts/diag_market_execution.mjs --only clv          # §0.1 — ~70 s
```

Lo script rispetta R14: le previsioni escono da `predictFromMatches` con `{ ...modelInputs(), … }`,
come `app.js` e come ogni backtest. Le sezioni `prezzo`, `multipla`, `combo` e `dipendenza` non
usano il modello e girano in un secondo.

## Appendice B — voci da aprire in `MISTAKES.md` quando i task chiudono

`MISTAKES.md` cataloga i difetti **arrivati in produzione**. V1, V2 e V3 lo sono: la schedina
pubblicata compra al prezzo medio, vieta le combo e ordina per vincita. Le voci vanno scritte
quando la correzione entra, con le quattro sezioni del formato in uso, e la terza — *«perche'
nessun test l'ha visto»* — e' gia' scritta in §2 per tutte e tre.

Le altre tre (V4, V5, V6) **non** vanno in `MISTAKES.md`: non sono difetti, sono termini del
problema che il progetto non rappresentava. La loro sede e' `docs/misure-riferimento.md`, come
misure numerate e citabili.
