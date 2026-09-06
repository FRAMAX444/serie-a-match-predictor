# PROMPT — Sessione 5: il miglior previsore possibile

> Risponde a un obiettivo **diverso** da quello di `PROMPT-sessione-4.md`, e i due non si
> contraddicono. Il documento 4 misura la convertibilita' in denaro e chiude la fase di
> accuratezza perche' *un log loss migliore non e' incassabile*. Questo documento assume che
> l'obiettivo sia **la previsione**, non la giocata, e mostra che con quell'obiettivo esiste un
> guadagno grande, gia' misurato, e mai raccolto. §0 dice esattamente dove passa il confine fra
> i due. Se l'obiettivo e' guadagnare, vale il documento 4; se e' prevedere, vale questo.

Riproduzione di ogni numero, senza rete:

```bash
node scripts/diag_signal_orthogonality.mjs          # bancata + diagnosi coppe, ~3 min
node scripts/diag_signal_orthogonality.mjs --only coppe    # ~75 s
node scripts/diag_market_execution.mjs --only dipendenza   # ~15 s
```

---

## 0. La domanda, e perche' le misure di tre sessioni non la chiudono

«Il miglior modello che preveda gli esiti nel modo migliore possibile» ha una risposta esatta, e
non e' quella che tre sessioni hanno cercato. Cercavano **il miglior modello endogeno**: un
previsore costruito da Elo, forma, xG e calendario. La risposta misurata e' che **il miglior
previsore disponibile e' un altro oggetto**, e che il modello endogeno serve — indispensabile —
solo dove quell'altro oggetto non esiste.

Il confine e' netto e si conta:

| | gare | copertura della linea di mercato |
|---|---|---|
| Big Five (campionati) | 5361 | **99.9%** |
| Coppe UEFA (ucl, uel, uecl) | 3150 | **0.0%** |
| **totale** | **8511** | 63% con linea, **37% senza** |

Due regimi, due problemi diversi, e finora il progetto ne ha affrontato uno solo — e per giunta
quello in cui era gia' battuto.

---

## 1. Le tre misure che definiscono il problema

### 1.1 Nessuno dei 22 segnali del modello aggiunge nulla alla linea di chiusura

E' la misura nuova di questa sessione, ed e' lo strumento che mancava a tutte le precedenti.
Per ogni segnale `z` si adatta un'inclinazione a **un solo parametro** sopra la linea di mercato
de-vigata con Shin:

```
p_casa ∝ p_mkt_casa · e^(+β·z)      p_pari ∝ p_mkt_pari      p_osp ∝ p_mkt_osp · e^(−β·z)
```

`β` si stima sul training (3402 gare, fino al 2025-05-31) e il guadagno si legge sull'holdout
(1851 gare, dal 2025-07-08). **Un parametro solo**: se anche cosi' il guadagno fuori campione e'
zero, il problema non e' come il segnale sia stato combinato — l'informazione non c'e'.

Su 22 segnali × 2 forme di inclinazione (asimmetria e pareggio) = **44 test**, piu' 9 sul livello:

```
segnale                              |  β      | guad. training | guad. HOLDOUT       | sigma
giorni di riposo                     | -0.013  |    +0.00005    |  +0.00078 ± 0.00146 |   0.53
tiri recenti                         | +0.058  |    +0.00086    |  +0.00034 ± 0.00093 |   0.37
Elo (differenza)                     | +0.053  |    +0.00066    |  -0.00014 ± 0.00110 |  -0.13
forza netta xG                       | +0.066  |    +0.00105    |  -0.00023 ± 0.00094 |  -0.25
sovra-rendimento xG                  | +0.056  |    +0.00085    |  -0.00082 ± 0.00074 |  -1.11
MODELLO: asimmetria contro mercato   | -0.091  |    +0.00218    |  -0.00126 ± 0.00155 |  -0.82
```

**Nessun segnale raggiunge 2σ sull'holdout. Il migliore sta a 0.53σ.** E il quadro complessivo e'
piu' duro del singolo numero:

- **33 test su 44 guadagnano sul training e perdono sull'holdout.** E' la firma del
  sovradattamento allo stato puro: i guadagni di training (da +0.00005 a +0.00218) sono tutti
  rumore adattato.
- **Il disaccordo del modello col mercato ha β = −0.091, cioe' NEGATIVO.** Sul training la
  procedura vuole inclinare *contro* il modello: quando il modello dissente dal mercato, i dati
  dicono di dare ragione al mercato **e un po' di piu'**. Nemmeno quello regge fuori campione
  (−0.00126), ma la direzione dice tutto.
- Sull'Over/Under 2.5 l'esito e' identico: 9 segnali, il migliore a 0.53σ, `β = −0.123` sul
  disaccordo del modello.

Questo e' molto piu' forte del `w = 1.000` del documento 4. Quello diceva *«questa combinazione
non aggiunge»*. Questo dice **«nessuna combinazione di queste feature puo' aggiungere, perche'
nessuna delle feature aggiunge»**. Lo spazio delle feature su cui il modello e' costruito e'
contenuto nella linea di chiusura.

### 1.2 Dove la linea esiste, ancorarsi ad essa vale piu' di tutto cio' che e' stato tentato

Il rovescio della medaglia e' un guadagno immediato, gia' misurato, che nessuno ha raccolto.

La matrice dei punteggi si **riancora al mercato**: si risolvono `λ_casa`, `λ_trasferta` e `ρ`
perche' riproduca esattamente `P(1)`, `P(X)` e `P(Over 2.5)` della linea de-vigata. Tre incognite,
tre vincoli, sistema esattamente determinato, **risolto su 5252 gare su 5253**. Le marginali
diventano quelle del mercato; la dipendenza resta quella del modello, che il documento 4 misura
calibrata al **97.9% ± 2.2%**.

Guadagno di log loss, confronto appaiato sulle stesse gare:

| mercato | modello | riancorato | guadagno | σ |
|---|---|---|---|---|
| 1X2 (chiusura) | 0.9913 | 0.9628 | **+0.0285 ± 0.0026** | 11.0 |
| 1X2 (apertura) | 0.9913 | 0.9650 | **+0.0263 ± 0.0025** | 10.6 |
| Over/Under 2.5 | 0.6803 | 0.6652 | **+0.0151 ± 0.0018** | 8.6 |
| X2 (pareggio o trasferta) | 0.6171 | 0.5944 | **+0.0227 ± 0.0023** | 10.0 |
| 1X (casa o pareggio) | 0.5574 | 0.5382 | **+0.0192 ± 0.0022** | 8.7 |
| Over 1.5 | 0.5261 | 0.5153 | **+0.0108 ± 0.0014** | 7.7 |
| Gol (entrambe segnano) | 0.6855 | 0.6789 | **+0.0066 ± 0.0014** | 4.9 |
| 12 (nessun pareggio) | 0.5646 | 0.5598 | **+0.0048 ± 0.0010** | 4.7 |

Per dimensionare: **tre sessioni di lavoro, dieci ipotesi strutturali testate, zero parametri
accettati, guadagno complessivo sul log loss pari a zero.** Questo vale +0.0285 sull'1X2, oggi,
senza stimare niente. E' piu' grande dell'intero divario che il progetto ha passato tre sessioni
a cercare di chiudere, perche' **e'** quel divario, incassato invece che inseguito.

Le due righe apertura/chiusura risolvono in anticipo l'obiezione di tempistica: in produzione le
quote disponibili non sono quelle di chiusura, ma quelle piu' vicine al momento in cui si guarda
la pagina. Ancorarsi all'**apertura** — il caso peggiore — vale comunque +0.0263.

### 1.3 Dove la linea non esiste, il modello e' quasi cieco, e la causa e' un buco di dati

3150 gare di coppa, copertura quote 0%. Qui il modello e' l'unico stimatore e nessuna misura del
documento 4 lo tocca. Il riferimento diventa la frequenza storica fissa (43.7 / 24.4 / 31.9),
cioe' **non sapere niente**:

```
gruppo                             |    n | logLoss | accuratezza | guadagno sul prior fisso | σ
entrambe con >= 20 gare domestiche |  259 | 0.9799  |    57.1%    |     0.0518 ± 0.0205      | 2.5
una sola con >= 20                 |  513 | 0.9842  |    53.2%    |     0.0469 ± 0.0160      | 2.9
nessuna delle due                  | 2271 | 1.0341  |    49.8%    |     0.0148 ± 0.0053      | 2.8
```

**L'informativita' del modello crolla di tre volte e mezzo** quando le due squadre non hanno dati
di campionato — e quel gruppo e' 2271 gare su 3043, cioe' il 75%. Per competizione:

```
  ucl   n= 824  logLoss 0.9954  guadagno sul prior 0.0451 ± 0.0120 (3.8σ)  ·  54% di gare cieche
  uel   n= 795  logLoss 1.0185  guadagno sul prior 0.0237 ± 0.0094 (2.5σ)  ·  69% di gare cieche
  uecl  n=1424  logLoss 1.0373  guadagno sul prior 0.0107 ± 0.0067 (1.6σ)  ·  90% di gare cieche
```

**In Conference League il modello e' statisticamente indistinguibile dal non sapere niente**:
+0.0107 ± 0.0067 su 1424 gare, 1.6σ. Sono il 47% di tutte le gare di coppa e il 17% dell'intero
dataset.

La causa e' misurata e non e' il modello:

```
squadre viste in coppa: 384
di cui senza NESSUNA gara non-di-coppa nel dataset: 328  (85%)
```

`DOMESTIC_LEAGUES` in `scripts/update_europe_data.py` contiene **cinque voci**: `E0`, `SP1`, `I1`,
`D1`, `F1`. Il dataset contiene otto competizioni in tutto — i Big Five e le tre coppe, nient'altro.
Per Ferencvaros, Qarabag, Bodo/Glimt, Ludogorets, Panathinaikos, Fenerbahce, PAOK, Braga,
Copenhagen, Midtjylland, Club Bruges — le squadre che *popolano* le coppe — il modello non ha
Elo costruito su un campionato, non ha forma, non ha xG, e non ha una linea di mercato da cui
dedurli. Ha solo le loro poche gare di coppa contro avversari eterogenei.

> Nota: `CLAUDE.md` dice che «i campionati minori esistono nel dataset solo come supporto interno
> a forma ed Elo». **Non e' vero sul dataset attuale: non esistono affatto.** La frase va corretta
> insieme al resto.

E il trasferimento non e' una scorciatoia: solo il **9.5%** delle gare di coppa ha entrambe le
squadre con abbastanza gare quotate da dedurne un rating implicito nel mercato, e il 69.7% non ne
ha nessuna. Non si puo' importare l'informazione del mercato dove serve. **Bisogna importare i
campionati.**

---

## 2. La risposta: il miglior previsore possibile e' a due regimi

```
                   esiste una linea di mercato per questa gara?
                                  |
              ┌───────────────────┴───────────────────┐
             SI (63%)                                NO (37%)
              │                                       │
   marginali  = mercato (Shin)              marginali = modello endogeno
   dipendenza = modello (97.9%)             dipendenza = modello (97.9%)
   → matrice riancorata                     → matrice del modello
   guadagno misurato +0.0285                qui ogni miglioramento del
   su 1X2, 4.7-11σ su ogni                  modello vale 1:1, e qui il
   mercato derivato                         modello oggi e' quasi cieco
```

Non e' un compromesso: e' la sola architettura coerente con cio' che e' misurato. Il modello
endogeno **non viene ritirato** — resta indispensabile su 3150 gare, resta la sorgente della
dipendenza su tutte e 8511, e resta l'unica cosa che produce i mercati che nessun banco prezza.
Cambia solo che smette di competere con il mercato dove il mercato c'e'.

---

## 3. Il piano — cinque task

### T1 — Ancoraggio al mercato · nessuna precondizione · **il guadagno e' gia' misurato**

Non e' un'ipotesi da testare: e' un'implementazione da fare. I numeri di §1.2 sono l'esito, non
la promessa.

1. Promuovere `anchorToMarket()` da `scripts/diag_market_execution.mjs` a `model.js`, accanto a
   `scoreMatrix`. Risolve `(λ_casa, λ_trasferta, ρ)` su `P(1)`, `P(X)`, `P(Over 2.5)`.
2. Promuovere `shinDevig()` allo stesso modo (vedi anche T5 del documento 4).
3. `predictFromMatches` accetta `marketOdds` come input dichiarato. **R14: va in
   `MODEL_INPUT_DEFAULTS`**, quindi raggiunge la pagina *e* ogni backtest, oppure nessuno dei due.
4. Quando le quote ci sono, `probabilities` e `deriveMarkets` nascono dalla matrice riancorata.
   Quando non ci sono, da quella endogena. In entrambi i casi **una sola matrice**, quindi i
   mercati restano internamente coerenti — la proprieta' che il progetto ha sempre difeso.
5. L'interfaccia **dichiara quale regime e' attivo**. Una previsione ancorata al mercato e una
   endogena non sono la stessa cosa e non vanno mostrate come tali.

**R13.** La linea di chiusura e' fissata *prima* del fischio d'inizio: usarla non e' guardare il
futuro. Ma la produzione vede quote piu' precoci della chiusura, quindi il backtest va fatto
contro **entrambe** e riportare entrambe — e' esattamente la disciplina di `MISTAKES.md` §25,
dove un numero che non dichiarava il proprio benchmark si e' rivelato calcolato sul benchmark
sbagliato.

**Avvertenza che va nel codice, non solo qui.** Una previsione ancorata al mercato ha, per
costruzione, **valore atteso esattamente nullo contro quel mercato**. Usarla per «cercare valore»
produce zero ovunque, ed e' un ragionamento circolare. `schedina.js` deve continuare a usare le
probabilita' **endogene** per l'EV, e quelle ancorate per cio' che mostra all'utente. Sono due
oggetti diversi e vanno tenuti separati — la stessa distinzione che `MISTAKES.md` §21 ha gia'
insegnato una volta a caro prezzo.

**Verifica:** senza quote, la previsione deve essere identica bit per bit a quella di oggi (R1).
Con le quote, il riancoraggio deve riprodurre le marginali di mercato entro `1e-5` su ogni gara,
e fallire in modo dichiarato quando non converge (1 gara su 5253).

### T2 — I campionati mancanti · **e' il task che vale di piu' sul lungo periodo**

Football-Data.co.uk pubblica, **allo stesso indirizzo, nello stesso formato e con le stesse
colonne di quote** gia' lette da `parse_csv()`: Olanda (`N1`), Portogallo (`P1`), Belgio (`B1`),
Scozia (`SC0`), Turchia (`T1`), Grecia (`G1`), piu' i secondi livelli (`E1`, `SP2`, `I2`, `D2`,
`F2`) e un file separato per Danimarca, Norvegia, Svezia, Svizzera, Austria, Polonia, Romania,
Irlanda. `DOMESTIC_LEAGUES` ha cinque righe: aggiungerne dieci e' una modifica di **dati**, non
di modello, ed e' la sola famiglia che in tre sessioni abbia mai pagato.

Cosa arriva insieme ai campionati: Elo costruito su un campionato vero, forma, xG dove
Understat copre, **e una linea di mercato** — che per quelle squadre rende applicabile anche T1.

**Il rischio e' uno solo, ed e' il piu' costoso della storia del progetto.** La normalizzazione
dei nomi squadra e' la famiglia di difetti che e' costata di piu' (`MISTAKES.md` §3, §7, §19,
§20, §27; `docs/misure-riferimento.md` §23 vale da sola +0.0145 in Champions). Passare da 5 a 15
campionati moltiplica quella superficie, e le grafie UEFA delle squadre dell'est europeo sono
peggiori di quelle dei Big Five, non migliori.

**Ordine obbligatorio, e non e' negoziabile:**

1. **Prima** estendere `tests/test_dataset_identity_contract.py` e
   `tests/test_team_name_normalization.py` perche' falliscano su una collisione di grafia fra
   una squadra di coppa e una di campionato nuovo. Verificato introducendo l'errore a mano.
2. **Poi** aggiungere i campionati, uno alla volta, misurando dopo ognuno quante identita' di
   club si ricompongono e quante se ne spezzano.
3. **Mai** esporli in `SUPPORTED_COMPETITIONS`: restano supporto interno a Elo e forma, come
   `CLAUDE.md` gia' prescrive. Il selettore non cambia.

**Cancello di copertura (R15, pre-registrato).** Dopo l'aggiunta, la quota di gare di coppa in cui
**nessuna delle due squadre** ha ≥ 20 gare di campionato deve scendere **sotto il 40%** (oggi e'
il 75%). Se resta sopra, i campionati aggiunti non sono quelli che popolano le coppe e il task
va rifatto scegliendoli dalla lista delle squadre orfane, non dalla dimensione del campionato.

**Criterio di successo (R15, pre-registrato).** Il guadagno sul prior fisso in **Conference
League** deve salire da `0.0107 ± 0.0067` ad **almeno `0.0250` con ≥ 2σ**, misurato sulle stesse
gare. Se non ci arriva, il buco di dati non era la causa e la cecita' in coppa va indagata
altrove.

### T3 — `ρ` sulla congiunta · precondizione: T1

`docs/misure-riferimento.md` §16 ha respinto `ρ = −0.10` e la lista «Da non riaprire» del
documento 3 lo elenca. **Il rifiuto resta valido nel suo dominio e non si estende a questo**, per
una ragione che §16 stessa scrive: spostare 1.3pp fra il pareggio e gli altri due esiti *e' quasi
neutro nel log loss dell'1X2*. Sulla **congiunta** non e' neutro affatto, ed e' la congiunta che
governa ogni mercato derivato.

Due indizi indipendenti puntano nella stessa direzione: la curva di affidabilita' (§14) e il `ρ`
implicito nella linea di mercato, che misura **−0.0817 di media e −0.0846 di mediana** contro il
−0.04 di produzione.

**Criterio di successo, pre-registrato:** log loss medio sulle **70 coppie** di
`diag_market_execution.mjs --only dipendenza`, con marginali riancorate al mercato in entrambi i
bracci (cosi' che l'unica differenza sia `ρ`). Miglioramento richiesto: **≥ 0.0020 sull'holdout,
a ≥ 2σ**. Se fallisce, `ρ` resta −0.04 e la voce si chiude **definitivamente**, in entrambi i
domini.

### T4 — Calibrazione dedicata alle coppe, rifatta · precondizione: T2 superato

`docs/misure-riferimento.md` §13 l'ha respinta e il documento 3 la elenca fra le cose da non
riaprire. Va riaperta **solo se T2 supera il suo cancello**, e per un motivo preciso: quella
misura e' stata fatta su un dataset in cui l'85% delle squadre di coppa non aveva dati domestici.
Non stimava una calibrazione di coppa — stimava una calibrazione su previsioni prive di input.
Con i campionati aggiunti l'oggetto stimato e' diverso, quindi il rifiuto precedente non si
applica.

Se T2 fallisce il suo cancello, **T4 non si apre.**

### T5 — Mercati sui giocatori · precondizione: nessuna

`PROMPT-sessione-3.md` §4 lo indica gia' come valore residuo, e `estimatePlayerMarkets` non e'
mai stato validato contro nulla. E' l'unico dominio in cui esiste un mercato *e* il modello non
e' necessariamente dietro, perche' i banchi ci mettono molto meno lavoro che sull'1X2. La
bancata di ortogonalita' di §1.1 e' lo strumento giusto anche qui, con la stessa soglia.

Costo alto (serve raccogliere quote giocatore, che su the-odds-api sono una richiesta per evento
per regione) e beneficio incerto. Ultimo in ordine.

---

## 4. Il criterio di successo, ridefinito — e questa e' la parte che cambia il metodo

Tre sessioni hanno accettato o respinto meccanismi sul **log loss del modello preso da solo**.
§1.1 dimostra che quel criterio non distingue il segnale dal rumore: 33 test su 44 lo hanno
superato sul training e sono morti sull'holdout.

Da qui in avanti, per regime:

| dove | criterio di accettazione | strumento |
|---|---|---|
| gare con linea di mercato | il segnale deve **battere la linea** sull'holdout, ≥ 2σ, con soglia pre-registrata | `diag_signal_orthogonality.mjs` |
| gare senza linea (coppe) | guadagno sul **prior fisso**, ≥ 2σ, sulle stesse gare | `--only coppe` |
| struttura di dipendenza | log loss sulle 70 coppie, marginali riancorate in entrambi i bracci | `diag_market_execution.mjs --only dipendenza` |

**Il log loss del modello endogeno sui campionati non e' piu' un criterio di accettazione per
nulla.** Resta una diagnostica — dice se il modello e' rotto — ma non decide piu' se un
meccanismo entra.

Una conseguenza pratica: la bancata di ortogonalita' costa **due minuti**. Ogni idea futura si
testa prima di implementarla, non dopo. Le dieci ipotesi respinte in tre sessioni sarebbero
costate mezz'ora invece che tre sessioni, e il documento 3 avrebbe potuto chiudersi con la stessa
conclusione al primo giorno.

---

## 5. Pre-registrazione (R15), scritta prima di guardare qualunque esito

| # | ipotesi | misura | soglia | decisione se fallisce |
|---|---|---|---|---|
| P1 | l'ancoraggio migliora la previsione mostrata | log loss appaiato, campionati, contro apertura **e** chiusura | **≥ +0.020 su entrambe** | gia' misurato a +0.0263 / +0.0285: se il codice non lo riproduce, e' un difetto di implementazione, non un'ipotesi respinta |
| P2 | i campionati mancanti coprono le squadre di coppa | quota di gare di coppa con **nessuna** squadra a ≥ 20 gare | **< 40%** (oggi 75%) | rifare la scelta dei campionati dalla lista delle orfane |
| P3 | la copertura si converte in accuratezza | guadagno sul prior in UECL | **≥ 0.0250 a ≥ 2σ** (oggi 0.0107 ± 0.0067) | il buco di dati non era la causa; T4 non si apre |
| P4 | `ρ` piu' negativo migliora la congiunta | log loss sulle 70 coppie, holdout | **≥ +0.0020 a ≥ 2σ** | `ρ` resta −0.04, voce chiusa in entrambi i domini |

**Regola sul numero di prove.** La bancata esegue 53 test in un colpo. A quella numerosita' una
casella a 2σ e' attesa dal caso: le soglie qui sopra valgono su ipotesi **dichiarate prima**, e
un segnale trovato *dentro* la bancata va ri-testato su una finestra successiva prima di
crederci. E' la stessa avvertenza di `docs/misure-riferimento.md` §27.1.

---

## 6. Cosa NON fare

1. **Non cercare un segnale endogeno nuovo per i campionati prima di aver passato la bancata.**
   22 segnali, 44 test, zero a 2σ. Un segnale nuovo va provato li' in due minuti, non
   implementato e misurato in una sessione.
2. **Non usare la previsione ancorata per cercare valore contro il mercato.** Vale zero per
   costruzione. L'EV della schedina resta sulle probabilita' endogene.
3. **Non aggiungere parametri.** Dieci meccanismi provati, dieci respinti, e §1.1 spiega ora
   *perche'*: lo spazio delle feature e' contenuto nella linea. La lista «Da non riaprire» di
   `PROMPT-sessione-3.md` §6 resta valida, con la sola eccezione di `ρ` sulla congiunta (T3),
   che e' un dominio diverso e non lo stesso test rifatto.
4. **Non aggiungere campionati senza prima estendere i contratti di identita'.** E' la famiglia
   di difetti piu' costosa del progetto, e T2 ne moltiplica la superficie per tre.
5. **Non esporre i campionati nuovi nel selettore.** Sono supporto interno a Elo e forma. Ogni
   competizione mostrata e' una promessa di copertura che la pipeline non mantiene.
6. **Non riaprire la calibrazione di coppa prima di T2.** La misura che l'ha respinta e' stata
   fatta su previsioni prive di input, e rifarla sugli stessi dati darebbe lo stesso esito per la
   stessa ragione sbagliata.
7. **Non leggere §1.2 come «il modello e' inutile».** Regge 3150 gare da solo, fornisce la
   dipendenza su tutte e 8511, e produce ogni mercato che nessun banco prezza. Cambia il suo
   ruolo, non la sua necessita'.

---

## 7. Rischi e limiti, dichiarati

1. **L'ancoraggio rende la previsione dipendente da una fonte esterna.** Se the-odds-api non
   risponde, il regime torna endogeno: va gestito come degradazione dichiarata, mai come errore
   silenzioso. E' lo stesso principio gia' applicato alle quote della schedina.
2. **La copertura quote in produzione non e' quella del dataset.** Football-Data copre il 99.9%
   dei campionati *a posteriori*; the-odds-api copre le gare *future* con una disponibilita' che
   dipende dal piano e dal momento. Il regime va deciso per gara, non per competizione.
3. **T2 puo' peggiorare le cose prima di migliorarle.** Ogni campionato aggiunto porta nuove
   grafie, e una grafia divergente non solleva un'eccezione: produce numeri plausibili e un club
   spezzato in due identita'. Per questo l'ordine di T2 e' vincolante.
4. **Il guadagno di §1.2 e' misurato sui Big Five 2023-2026.** Vale li'. Sui campionati aggiunti
   da T2 la linea di mercato e' piu' larga e il guadagno dell'ancoraggio sara' minore: va
   rimisurato per competizione, non estrapolato.
5. **Niente di questo aumenta il vantaggio economico.** Il documento 4 resta valido parola per
   parola: ancorarsi al mercato porta l'accuratezza al livello del mercato e il vantaggio a
   esattamente zero. I due obiettivi sono separati, e questo documento persegue il primo.

---

## Appendice — riproduzione

```bash
node scripts/diag_signal_orthogonality.mjs                 # bancata 1X2 + livello + coppe
node scripts/diag_signal_orthogonality.mjs --only 1x2      # §1.1, 44 test
node scripts/diag_signal_orthogonality.mjs --only livello  # §1.1, dimensione del livello
node scripts/diag_signal_orthogonality.mjs --only coppe    # §1.3
node scripts/diag_market_execution.mjs --only dipendenza   # la dipendenza al 97.9%
```

Entrambi gli script rispettano R14: ogni previsione esce da `predictFromMatches` con
`{ ...modelInputs(), … }`, come `app.js` e come ogni backtest.
