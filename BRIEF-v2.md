# BRIEF v2 — modello di previsione, stato accertato e coda di lavoro

> Sostituisce `BRIEF-claude-code.md` (v1). Il v1 resta leggibile come **documento storico**: il suo
> protocollo era buono, le sue diagnosi meccaniche erano corrette, e la maggior parte delle sue
> inferenze su cosa correggere sono state falsificate sui dati. I suoi numeri di riferimento sono
> tutti stali.
>
> Tutti i numeri qui hanno accanto la data del dataset su cui sono misurati. La fonte unica e viva
> è `docs/misure-riferimento.md`; questo file è la sintesi che si legge per prima.

---

## 0. Protocollo — R1-R12

R1-R8 vengono dal v1 e restano in vigore. R9-R12 sono stati aggiunti dopo averli pagati.

| | regola | perché esiste |
|---|---|---|
| **R1** | ogni parametro nuovo, a valore neutro, riproduce l'output attuale **bit per bit** | `(x-a)+a` non è `x` in virgola mobile: la neutralità va ottenuta con un'uscita anticipata, non sperata |
| **R2** | il test di regressione si scrive **prima** e deve **fallire** | un dato mancante non solleva eccezioni: produce un numero plausibile |
| **R3** | confronto **appaiato** obbligatorio | errore std appaiato 0.0002 contro 0.0154 non appaiato: 77 volte più piccolo |
| **R4** | ricalibrare dopo una modifica che tocca molte gare | ma vedi R12: eseguire e misurare, adottare solo se batte l'attuale sull'holdout |
| **R5** | segmentare sempre: fase di stagione, lega, copertura xG | un guadagno aggregato che nasconde un peggioramento su un segmento non è un guadagno |
| **R6** | direzione dell'effetto verificata **prima** e **indipendentemente** dal log loss | se la direzione è sbagliata la modifica sta compensando un altro errore |
| **R7** | la stagione `2526` è holdout: stimare su `2324`+`2425` | il refit di calibrazione migliora in training e degrada fuori: senza holdout sarebbe stato adottato |
| **R8** | un cantiere alla volta, mai stimare più parametri insieme | `tune_hyperparameters` cerca già su 16 dimensioni |
| **R9** | un meccanismo che dipende dallo storico va applicato **anche in previsione** | alla prima giornata assoluta nessuna gara della stagione nuova è nel dataset: un meccanismo che scatta solo attraversando un confine presente nei dati non scatta mai proprio quando serve. Scoperto due volte (Task 3 e 4) |
| **R10** | nessun gancio inerte: o si rimuove, o si conserva **con la misura scritta accanto** | il v1 denunciava otto ganci a valore costante; la sessione 1 ne ha creati quattro nuovi |
| **R11** | verificare che lo strumento tocchi un numero di gare **diverso da zero e plausibile** prima di credergli | `diag_paired_ab.mjs` filtrava via le coppe: il fattore europeo risultava toccare 0/2779 gare. Ora la riga "GARE TOCCATE" è obbligatoria e lo strumento esce con errore se è zero |
| **R12** | l'ipotesi generata su una finestra si verifica su un'altra | due ipotesi nate guardando l'holdout (calibrazione dedicata alle coppe, sotto-sicurezza agli estremi) sono cadute entrambe al test corretto |

---

## 1. Stato del modello — dataset del 25/08/2026, 8403 gare

```
npm run backtest -- --competition ita.1
  -> logLoss 0.9886 · RPS 0.1954 · accuracy 0.527 · 1000 gare (2023-12-11 -> 2026-08-23)
```

**Distanza dal mercato**, confronto appaiato su 3657 gare con quote (99.4% dei Big Five, 0% delle
coppe):

```
log loss modello : 0.9912
log loss mercato : 0.9697
divario appaiato : +0.0214 ± 0.0028   ->  7.6 sigma
```

Lo spazio disponibile è **0.0214**, non lo 0.017 del v1 (stimato su un campione diverso e senza
appaiamento).

### 1.1 Copertura dei dati, dopo la correzione degli alias

| campo | prima | dopo |
|---|---|---|
| xG `esp.1` / `ger.1` | 36% / 23% | **99.7% / 100%** |
| tiri, corner, cartellini | 64.1% | **100%** |
| quote (Big Five) | 60.9% | **99.4%** |
| possesso | 9.1% | 14.9% — **resta inutilizzabile** |
| arbitro | — | 21.5% delle gare passate, 0% delle future |

---

## 2. Diagnosi misurata — riscritta come esiti

### 2.1 Il costo di inizio stagione è reale, è del modello, ed è il difetto più grande

```
fascia   |    n | logLoss mod | logLoss mkt | divario  | sigma
01-03    |  296 |      1.0118 |      0.9539 | +0.0579 |  4.28
04-06    |  275 |      0.9703 |      0.9444 | +0.0259 |  2.51
07-10    |  365 |      0.9911 |      0.9687 | +0.0224 |  2.64
11-19    |  838 |      0.9825 |      0.9702 | +0.0123 |  2.19
20+      | 1883 |      0.9949 |      0.9759 | +0.0190 |  5.03
```

**Il mercato prevede le prime tre giornate meglio della sua media stagionale** (0.9539 contro
0.9759). Non sono partite intrinsecamente difficili: il modello perde lì tre volte più che altrove.

Il v1 attribuiva il costo alla sovra-sicurezza sul rapporto di forza ereditato. **Quella spiegazione
è falsa** (§3.1). La causa resta ignota ed è la domanda aperta più preziosa (§5).

### 2.2 Il modello sotto-prevede i pareggi

Curva di affidabilità su 5194 gare dei Big Five, bande aggregate su casa e trasferta:

```
fascia                       |    n | previsto | osservato | scarto             | sigma
estreme  (previsto >= 0.55)  | 1351 |    0.676 |     0.684 | +0.0083 ± 0.0126   |  0.66
medie    (0.30 - 0.55)       | 4547 |    0.444 |     0.448 | +0.0048 ± 0.0073   |  0.66
basse    (< 0.30)            | 4490 |    0.222 |     0.200 | -0.0224 ± 0.0061   | -3.67
```

```
esito       previsto   osservato   bias
casa          0.4370      0.4307   +0.0063
pareggio      0.2436      0.2566   -0.0130
trasferta     0.3194      0.3127   +0.0067
```

Il modello dà **1.3pp in meno** al pareggio e troppa probabilità agli esiti improbabili. Il commento
di `rho = -0.04` in `model.js` dice che quel valore fu scelto perché lasciava il bias sui pareggi a
-0.4pp contro -1.4pp con `rho = 0`: oggi misura **-1.30pp**, cioè è tornato dove era.

### 2.3 Il vantaggio campo è già interamente catturato

Trend inesistente (2 leghe su 5 in calo, p=81%). Residuo per lega: chi-quadro **5.18 su 5 gradi di
libertà**, cioè il valore atteso. Residuo per squadra: sembrava reale a 1.8 sigma, ma al netto del
residuo in trasferta scende a **0.14 sigma** — era forza mal stimata, non venue.

### 2.4 I regimi sono due, non uno

Campionati e coppe si comportano in modo diverso su almeno due assi, e il numero aggregato è la loro
media:

| | Big Five | coppe UEFA |
|---|---|---|
| `quality.score`, 5° percentile | 0.995 | 0.597 |
| gare sotto `quality` 0.75 | 0.1% | 13.9% |
| effetto del refit di calibrazione | −0.0018…−0.0030 | +0.0021…+0.0035 |
| copertura quote | 99.4% | 0% |

`asymmetryShrinkLowQuality` è quindi **inerte sui campionati e attivo su un terzo delle gare di
coppa**: non è codice morto. Una calibrazione dedicata alle coppe è stata però **testata e
respinta** (§3.2).

### 2.5 Ganci ancora inerti

`squad_continuity` (costante 0.85), `newcomer_impact`, `departure_impact`, `manager_change_days`
(sempre `None`), `availability_*` e `promotion_*` (`≠1` per 0 squadre su 303),
`data/context_overrides.json` che non esiste. `importance` vale 1.0 per ogni gara domestica.

Risolti rispetto al v1: `lineup_strength` (ora bilaterale, mediana 1.0, 22 squadre sotto e 24 sopra)
e `refereeHomeBias` (ora cablato per partita da `app.js`, vale 0 quando l'arbitro è ignoto).

---

## 3. Conoscenza acquisita — non riaprire senza evidenza nuova

### 3.1 Scontare la forza ereditata dalla stagione precedente **peggiora**

Cinque meccanismi indipendenti, tutti peggiorativi, monotoni nell'intensità, su finestre
indipendenti:

| meccanismo | esito sull'holdout |
|---|---|
| compressione dell'asimmetria via `dataQuality` (v1 Task 2) | −0.0060 e −0.0056 sulle fasce 01-03 e 04-06 a peso 0.60 |
| regressione dell'Elo al confine di stagione (v1 Task 3) | −0.0037 ± 0.0022 e −0.0063 ± 0.0020 a k=0.7 |
| forma ortogonale all'Elo (v1 Task 7) | −0.0011 a peso 0.5, −0.0025 a peso 1.0, IC che escludono lo zero |
| ritenzione per anzianità dell'assenza (v1 Task 4) | −0.0007 ± 0.0003 |
| vantaggio campo differenziato (v1 Task 5) | residuo dentro il rumore, niente da catturare |

**L'Elo ereditato è informativo, non rumore da scontare.** Il caso della forma è il più
istruttivo: renderla ortogonale all'Elo ha ridotto la collinearità da 0.743 a 0.267 come voluto, ma
la correlazione con l'esito è scesa da 0.323 a 0.146. Le due misure non erano una copia l'una
dell'altra: erano la stessa quantità con rumore indipendente, e mediarle conviene.

### 3.2 Altre ipotesi testate e respinte

- **Ricalibrazione completa**: peggiora i campionati (−0.0018…−0.0030), migliora le coppe, aggregato
  neutro. `DEFAULT_CALIBRATION` resta.
- **Calibrazione dedicata alle coppe**: stimata sul training solo-coppe e validata sull'holdout
  solo-coppe, dà **−0.0004 ± 0.0019**. Il miglioramento visto nella scomposizione era un artefatto.
- **Sotto-sicurezza sui favoriti forti**: nata dal confronto col mercato (3pp), caduta al confronto
  con gli esiti (0.66 sigma).
- **`venueTilt` come artefatto del proxy dei tiri**: la misura resta vera (asimmetria xG reale 0.409
  contro 0.260 del proxy) ma l'holdout mostra che 0.018 resta il valore migliore.
- **Sovra-rendimento sugli xG**: segno che si inverte fra train e holdout.
- **Peso ridotto per le gare con rosso**: +0.0018 sull'holdout domestico (2.0 sigma) ma 1.6 sigma sul
  campione allargato, e la Champions peggiora di 2 sigma.
- **Il possesso come feature di stile**: 14.9% di copertura anche dopo la correzione dei dati.
- **`rho` e il deficit di pareggi**: direzione confermata, +0.0002 sull'holdout per ogni valore
  provato. Un difetto di calibrazione reale la cui correzione è neutra nel log loss.
- **Bias arbitro**: +0.0050 a 4.2 sigma con `referee_stats` così com'è, **+0.0001 ± 0.0010**
  ricalcolandolo solo sul passato. Il segnale era interamente leakage.
- **Interazione di stile sul volume dei tiri**: nessun guadagno.

### 3.3 Correzioni entrate in produzione

Sono le uniche modifiche che cambiano le previsioni, e **nessuna è un parametro**:

1. **alias delle squadre** — 25 famiglie, 210 righe duplicate rimosse, identità di club ricomposte
   attraverso il confine coppe/campionato;
2. **rilevamento delle neopromosse** — "non era in questa competizione la stagione scorsa" invece di
   "prima apparizione nel dataset"; gare toccate da 87/768 a 751/768;
3. **`lineup_strength` bidirezionale** — ancorato all'undici tipo della squadra stessa;
4. **`restDays` reale** — le coppe contano per il calendario anche quando non contano per Elo e
   medie (effetto sul log loss: −0.0002 ± 0.0004, cioè nullo; è una correzione di dato);
5. **`refereeHomeBias` cablato** per partita da `app.js`.

---

## 4. Coda

### ~~C1 — `rho` e il deficit di pareggi~~ — **testato e respinto**
Direzione confermata (a `rho = -0.10` il bias sui pareggi passa da −0.56pp a +0.76pp), guadagno sul
training che va in plateau a +0.0007, e **+0.0002 sull'holdout per qualunque valore**. `rho` resta a
−0.04.

Il difetto di §2.2 è quindi reale e misurato a 3.67 sigma, ma **correggerlo non paga**: spostare
1.3pp fra il pareggio e gli altri esiti è quasi neutro nel log loss. Il bias marginale sui pareggi
non è una leva utile — è una diagnostica, non un obiettivo.

### ~~C2 — bias arbitro~~ — **testato e respinto: era leakage**
Prima misura: +0.0050 ± 0.0012 (4.2 sigma) su 1114 gare. **Falsa**: `compute_referee_stats()` calcola
il bias di ogni arbitro su tutte le partite che ha diretto, inclusa quella da prevedere.

Rifatta in avanti (bias da sole partite precedenti, stessa formula): **+0.0001 ± 0.0010**. Zero.

**Lo scraping delle designazioni non va fatto**: era la voce più costosa del v1 e la misura che la
chiude è costata un'ora. E `payload.referee_stats` non è utilizzabile in nessun backtest, perché è
calcolato in-sample — lo stesso difetto che il v1 attribuiva agli archivi di sentiment, presentatosi
nella fonte più insospettabile del progetto.

### C3 — Capire perché la Premier League è diversa
È l'unica lega dove il divario dal mercato **non è distinguibile dal rumore** (+0.0102, 1.6 sigma)
contro 0.021-0.028 delle altre quattro. È anche la lega con più dati per squadra. Capire cosa la
renda diversa dice dove sono i rendimenti decrescenti.

### C4 — Fonte per infortuni e formazioni
Prerequisito ora soddisfatto (`lineup_strength` bidirezionale). Resta il contenuto informativo più
grande non ancora sfruttato, ed è la prima candidata a spiegare §5.

### C5 — Statistiche in lista d'attesa
Palle inattive, portiere (PSxG − xG), stato del punteggio, distanza di viaggio, meteo, posta in
gioco, cambio allenatore, struttura della rosa. Motivazioni invariate rispetto al v1 §5.

**Decaduto**: la continuità di rosa (v1 Task 11). Il suo scopo dichiarato era modulare la `k` della
regressione Elo di v1 Task 3, che le misure dicono di lasciare a 1. Senza quello scopo non ha una
ragione autonoma, e va ripresa solo se qualcuno le trova un uso diverso.

---

## 5. La domanda aperta

Le prime tre giornate costano **+0.0579 di divario dal mercato** contro +0.0190 di fine stagione, e
il mercato lì fa **meglio** della sua media. Delle tre spiegazioni candidate del prompt di
sessione 2:

1. ~~non è un difetto del modello ma della realtà~~ — **respinta**: il mercato non ci perde;
2. **è un problema di livello, non di asimmetria** — i gol totali attesi a inizio stagione. Non
   ancora testata;
3. **è la varianza delle rose, non la loro forza media** — le squadre a inizio stagione sono più
   *disperse* attorno al proprio livello, non sistematicamente sopravvalutate. Richiede una
   correzione sulla forma della distribuzione, non sulla media. Non ancora testata, ed è l'unica
   coerente con §3.1: se il problema fosse la media, scontarla avrebbe aiutato, e non lo ha fatto.

La 3 è la candidata migliore e nessuno l'ha ancora provata.
