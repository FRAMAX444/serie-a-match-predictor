# PROMPT — Sessione 2

> Continuazione del lavoro sul brief `BRIEF-claude-code.md` (d'ora in poi **brief v1**).
> Questo documento **corregge** il brief v1 e ha precedenza su di esso ovunque siano in
> conflitto. Leggere §0 e §1 prima di qualsiasi altra cosa.

---

## 0. Avvertenza sulla fiducia da dare al brief v1

Il brief v1 ha funzionato come **protocollo** e ha fallito come **teoria**. Le sue diagnosi
meccaniche erano corrette; la maggior parte delle sue inferenze su cosa correggere sono state
falsificate sui dati nella sessione 1.

Cinque errori accertati del brief v1, da tenere presenti quando lo si rilegge:

| dove | il brief v1 diceva | i dati dicono |
|---|---|---|
| §2.1-2.3, tesi centrale | scontare la forza ereditata dalla stagione precedente migliora le previsioni | **falso**, su quattro meccanismi indipendenti e due finestre |
| §2.7 / Task 5 | il vantaggio campo per lega e per squadra è sotto-modellato | già interamente catturato: residuo lega χ²=5.18/5, residuo squadra 1.8σ → 0.14σ al netto della trasferta |
| Task 4 | ~15% delle gare coinvolge una neopromossa | 28.5% coinvolgimento diretto in Serie A, 98% con propagazione |
| Task 4 | prior ipotizzato −65 Elo | prior empirico **−128 Elo** (per lega, con shrinkage, fra −117 e −151) |
| Task 1 | quattro cause ipotizzate (slug, rate limit, `datesData`, fallback) | **nessuna delle quattro**: era la chiave di aggancio dei nomi squadra, 25 famiglie di alias |

**Conseguenza operativa**: il brief v1 resta valido come definizione del protocollo (§0, §6, §7) e
come inventario dei ganci esistenti (§2.8). Le sue sezioni §2.1-§2.7 vanno lette come *diagnosi
storica*, non come programma. I numeri di riferimento in §2 sono **stali**: il dataset è cambiato
materialmente (vedi §1.2).

---

## 1. Stato accertato al termine della sessione 1

### 1.1 Esiti dei task

| task | esito | evidenza decisiva |
|---|---|---|
| 0 strumenti | ✅ completo | riferimenti §1.3/§2.1/§2.4/§2.6 riprodotti; **ma lo strumento aveva un bug**, vedi §2.1 |
| 1 copertura xG | ✅ risolto | causa reale: chiave di aggancio, 25 famiglie di alias. esp.1 36%→99.7%, ger.1 23%→100% |
| 2 dataQuality stagionale | ❌ respinto | ottimo a w=0; holdout w=0.60: −0.0060 (01-03) e −0.0056 (04-06), monotono |
| 3 regressione Elo | ❌ respinto | holdout k=0.7: 01-03 −0.0037 ± 0.0022, 04-06 −0.0063 ± 0.0020 (~3σ), effettivo su 1792/1792 |
| 4 neopromosse | ⚠️ bug corretto, prior spento | gare toccate 87/768 → 751/768; train +0.0011 IC [0.0003, 0.0019], holdout +0.0005 IC [−0.0003, 0.0013] |
| 5 vantaggio campo | ✅ chiuso senza modifiche | trend inesistente (2/5 leghe, p=81%); residui dentro il rumore |
| 6 congestione europea | ❌ respinto in A/B | direzione corretta (−0.023 sulle vittorie in trasferta europea, −1.9σ) ma sotto il rumore |
| 7 forma-residuo | ❌ respinto in A/B | collinearità risolta (0.743 → 0.267) ma nessun guadagno |
| 8 sovra-rendimento xG | ❌ respinto in A/B | — |
| 9 rossi precoci | 🟢 **non chiuso** | unico positivo su due finestre: train +0.0009, holdout +0.0018 IC [0.0000, 0.0035] |
| 13 lineup_strength | ✅ bilaterale | mediana 1.0000, 22 squadre sotto (min 0.9480), 24 sopra (max 1.0454); era 0 sotto / 95 sopra |
| 14 stile | ❌ respinto in A/B | — |
| 10 arbitro | ⬜ non cablato | `referee` presente sul 21.5% delle gare passate; `app.js` non passa `refereeHomeBias` |
| 11 continuità rosa | ⬜ **scopo decaduto** | doveva modulare la `k` di Task 3, che le misure dicono di lasciare a 1 |
| 12, 15 | ⬜ bloccati | fonti dati |

Verifica finale sessione 1: 21 suite JS, 59 test Python, `npm run check` verdi. Backtest
`ita.1` = **0.9883 / 0.525**, bit-identico con tutti i parametri nuovi a default.

### 1.2 Il dataset è cambiato: i riferimenti del brief v1 sono stali

Effetto della correzione di Task 1 (fusione delle righe duplicate sotto alias diversi):

| campo | prima | dopo |
|---|---|---|
| xG `esp.1` | 36% | 99.7% |
| xG `ger.1` | 23% | 100% |
| tiri / corner / cartellini | 64.1% | **100%** |
| quote | 60.9% | **99.4%** |
| possesso | 9.1% | 14.9% (**resta inutilizzabile**) |
| `quality.score` fascia 01-03 | 0.902 | 0.947 |
| `quality.score` fascia 20+ | 0.976 | **1.000** |

Ogni numero di §2 del brief v1 va considerato non valido finché non ricalcolato.

### 1.3 Il risultato più solido della sessione 1 è negativo, ed è un risultato

Cinque meccanismi indipendenti che riducono il peso della forza ereditata dalla stagione
precedente — compressione dell'asimmetria (2), regressione dell'Elo al confine (3), forma
ortogonale (7), ritenzione per assenza (sotto-caso di 4), e il vantaggio campo differenziato (5) —
**peggiorano tutti**, in modo monotono nell'intensità, su finestre indipendenti.

Registrarlo come conoscenza acquisita: **l'Elo ereditato dalla stagione precedente è informativo,
non rumore da scontare.** Il costo misurato di inizio stagione (log loss 1.018 contro 0.99) è
reale, ma non è sovra-sicurezza sul rapporto di forza. La sua causa resta ignota ed è una domanda
aperta, non un problema risolto.

---

## 2. Emendamenti al protocollo

I vincoli R1-R8 del brief v1 restano in vigore. Questi si aggiungono.

### R9 — Applicazione in avanti
Un meccanismo che dipende dallo storico deve essere applicato **anche al momento della
previsione**, non solo durante la ricostruzione dello stato. Alla prima giornata assoluta di una
stagione nessuna gara della stagione nuova è ancora nel dataset: un meccanismo che scatta solo
attraversando un confine presente nei dati **non scatta mai** proprio nel caso che conta di più.

Questo caso è stato scoperto due volte nella sessione 1 (Task 3 e Task 4) ed è la stessa forma di
inerzia che ha tenuto `newcomerEloDiscount` inattivo per mesi. Ogni nuovo meccanismo va verificato
esplicitamente su una fixture della prima giornata assoluta.

### R10 — Nessun gancio inerte lasciato indietro
Il brief v1 §7 denunciava otto ganci esistenti a valore costante. La sessione 1 ne ha creati
**quattro nuovi** (Task 6, 7, 8, 14: implementati, neutri, respinti). È lo stesso anti-pattern.

Regola: un parametro respinto viene **rimosso**, oppure conservato con la misura che lo ha
respinto scritta accanto nel codice, in modo che nessuno lo riaccenda per curiosità. Non esiste
la terza opzione "lasciato lì neutro senza spiegazione".

### R11 — Lo strumento di misura va verificato prima di credergli
Nella sessione 1 `diag_paired_ab.mjs` filtrava l'array alle sole competizioni domestiche,
rendendo il fattore europeo di Task 6 invisibile (0/2779 gare toccate). Il bug era **nel sorgente
inlinato nel brief v1**, quindi in nessun modo colpa dell'implementazione.

Regola: prima di usare una diagnostica per decidere, verificare che il meccanismo sotto test
**tocchi un numero di gare diverso da zero e plausibile**. Un risultato "nessun effetto" con
0 gare toccate non è un risultato: è uno strumento rotto.

### R12 — La ricalibrazione è stata testata e respinta una volta sola, non per task
`npm run fit:calibration` è stato eseguito nella sessione 1 con lo split R7: i parametri
ricalibrati **peggiorano sull'holdout 2526** (−0.0020 ± 0.0009, IC [−0.0038, −0.0004]).
`DEFAULT_CALIBRATION` attuale resta il migliore fuori dal periodo di stima.

R4 resta in vigore, ma va letto così: la ricalibrazione va **eseguita e misurata** dopo una
modifica che tocca molte gare, e **adottata solo se batte l'attuale sull'holdout**. Il default è
tenere i valori in produzione.

---

## 3. Coda della sessione 2

Ordinata. Non riordinare senza motivare.

---

### P1 — Chiudere Task 9 (l'unico risultato positivo, ed è incompleto)
**Costo: basso · Blocca: la sola modifica al modello che le misure sostengono**

Task 9 (rossi precoci fuori dalle medie) è l'unico parametro positivo su entrambe le finestre, ma
**non ha passato R4** e tocca **1786/1792 gare**. Una modifica di quella portata sposta la
distribuzione dei lambda grezzi: la calibrazione attuale potrebbe non essere più quella giusta, e
il guadagno potrebbe evaporare o crescere.

Da fare:
1. `npm run fit:calibration` con lo split R7, con Task 9 attivo;
2. confronto appaiato su holdout fra *(Task 9 + calibrazione attuale)* e *(Task 9 + calibrazione
   ristimata)*, applicando R12;
3. rivalidazione appaiata di Task 9 contro il modello senza Task 9, con la calibrazione vincente.

**Attenzione al limite inferiore**: l'IC holdout è `[0.0000, 0.0035]`. Tocca lo zero. Non è un
risultato solido, è un risultato marginale che soddisfa un criterio debole ("non peggiora"). Se
dopo la ricalibrazione l'IC include chiaramente lo zero, **chiuderlo come negativo** invece di
adottarlo perché è l'unico sopravvissuto. La tentazione di salvare l'unico positivo è
esattamente il bias che R6 e R7 esistono per bloccare.

---

### P2 — Audit delle misure fatte con lo strumento difettoso
**Costo: basso · Blocca: la fiducia in tutti i risultati della sessione 1**

`diag_paired_ab.mjs` filtrava via le competizioni europee. L'agente ha scartato le prime misure di
Task 6, correttamente. **Non è stato verificato se altre misure fossero contaminate.**

Da fare: elencare ogni misura della sessione 1 e classificarla come *sicura* (meccanismo
domestico-only, il filtro non cambia nulla) o *da rifare*. Candidati da controllare per primi:
- l'A/B di Task 1 (la correzione degli alias tocca anche le squadre europee — 22 gare di Athletic
  Bilbao erano sotto un terzo nome);
- l'A/B della calibrazione (§R12): se il filtro ha escluso le coppe, la stima e la validazione
  sono su un sottoinsieme diverso da quello su cui `fit_calibration.mjs` lavora;
- Task 4 (le neopromosse giocano anche i preliminari europei).

Poi: aggiungere a `diag_paired_ab.mjs` una **riga di output obbligatoria** con il numero di gare
toccate dal meccanismo, e un'uscita con errore se è zero (R11).

---

### P3 — Ri-misurare la distanza dal mercato
**Costo: basso · Blocca: il dimensionamento di tutto il lavoro residuo**

Le quote sono passate dal 60.9% al 99.4% di copertura. Il benchmark di
`backtest_vs_market.mjs` ha ora **il 63% di gare in più**, e non è mai stato rieseguito dopo
Task 1.

Il numero "0.017 di log loss di spazio verso il mercato" del brief v1 §1.3 è stimato su un
campione diverso e **non è più valido**. È il numero che decide se vale la pena continuare, e su
quali segmenti.

Da fare:
1. `npm run backtest:market` sul dataset corrente;
2. **segmentato** (R5): per lega, per fase di stagione, per fascia di probabilità. La domanda
   utile non è "quanto siamo indietro" ma "dove siamo indietro". Le prime tre giornate sono il
   candidato ovvio dopo §1.3;
3. aggiornare il numero di riferimento in `docs/misure-riferimento.md`.

Nota metodologica: i due backtest `ita.1` pre e post Task 1 (0.9878 e 0.9883) **non sono
confrontabili** — dataset diversi, quindi non appaiati. Non trattare quella differenza come un
peggioramento. L'unica misura valida di Task 1 è l'A/B appaiato (+0.0008 ± 0.0008 aggregato,
+0.0033 in `ger.1`).

---

### P4 — Decidere Task 4 con un test pre-registrato, non riaprirlo a occhio
**Costo: medio · È il segnale positivo più forte trovato, e sta spento**

Situazione: la correzione del rilevamento è merged; il prior è spento. Con il prior a −128 il
segmento 01-03 dà **train +0.0099 ± 0.0029 (3.4σ)** e **holdout +0.0013 (~1.3σ)**. Positivo
ovunque, significativo solo in training.

Questa è quasi certamente una **questione di potenza statistica, non di assenza di effetto**: il
segmento 01-03 sull'holdout ha poche gare. Riaprirlo guardando i numeri e decidendo dopo è
esattamente il modo di trasformare rumore in convinzione.

Da fare, **in quest'ordine e senza saltare il primo passo**:
1. **Verificare R7 sulla stima del prior.** Il valore −128 è stimato su 14 neopromosse su 5 leghe:
   **su quali stagioni?** Se `2526` è inclusa, R7 è violato e tutta la validazione holdout è
   invalida. Va verificato prima di ogni altra cosa.
2. **Pre-registrare** la regola di decisione: quale segmento, quale soglia in σ, quante gare
   minime, su quale finestra — scritta in `docs/` **prima** di eseguire.
3. Aumentare il campione dell'holdout: valutare il segmento su **tutte e cinque le leghe**
   insieme, non solo `ita.1`, e su tutte le stagioni disponibili fuori dal training.
4. Usare i prior **per lega con shrinkage** (−117 … −151), non il valore aggregato −128, se non è
   già così.
5. Applicare la regola pre-registrata e accettarne l'esito.

**Da non fare**: cercare la variante che passa. Il sotto-caso "ritenzione per staleness da sola"
è già stato misurato e peggiora — è il quinto membro della famiglia di §1.3 e non va ritentato.

---

### P5 — Pulizia dei ganci inerti (R10)
**Costo: basso · Debito che cresce se non pagato ora**

Dodici ganci a valore costante: otto ereditati (brief v1 §2.8) più quattro creati nella sessione 1.

Da fare, per ciascuno dei parametri di Task 6, 7, 8, 14:
- **rimuovere** quelli la cui respinta è decisiva e il meccanismo privo di futuro (7, 8, 14);
- **conservare con la misura inline** quelli dove il meccanismo è sano e il limite è la potenza —
  Task 6 ha direzione corretta (`−0.023` sulle vittorie in trasferta europea, `−1.9σ`, su 1128
  osservazioni pari al 15.9%): merita un commento che dica esattamente questo, così che chi lo
  ritrova sappia che è stato misurato e perché è spento.

Nel farlo, sistemare anche una cosa che Task 6 ha scoperto e che **non è un parametro ma un bug**:
per le previsioni domestiche il modello filtra via le partite europee, quindi `restDays` è
calcolato male — il modello crede che quelle squadre abbiano riposato **6 giorni più del vero**.
Questo va corretto indipendentemente dal fatto che il fattore di congestione sia stato respinto:
è un dato sbagliato, non un'ipotesi respinta. Vale R2 (test prima) e va misurato separatamente.

---

### P6 — `quality.score` è ora saturo: decidere cosa farne
**Costo: basso · Chiarisce un meccanismo oggi provabilmente morto**

Dopo Task 1 la copertura xG satura ha portato `quality.score` a **1.000** nella fascia 20+ e a
0.947 nella 01-03. `asymmetryShrinkLowQuality = 0.30` non è più solo inerte: l'interpolazione non
lascia mai la cima del suo intervallo.

**Attenzione a non trarre la conclusione sbagliata.** Task 2 ha dimostrato che far scendere
`quality` a inizio stagione **peggiora**. Quindi la risposta non è "riattivare il ramo di bassa
qualità". Le opzioni sono:
- **ritirare il ramo** come codice morto, documentando che è stato misurato e che accenderlo
  peggiora (rende onesta `DEFAULT_CALIBRATION`, che oggi espone un parametro che non fa niente);
- **ricalibrare la scala** di `dataQuality`: le sue componenti erano tarate in un mondo con il 40%
  di copertura xG e ora una di esse è costante. Un indicatore che vale 1.000 per la maggioranza
  delle gare ha perso ogni potere discriminante, e viene usato anche altrove.

Misurare prima quale delle due, non sceglierla per gusto. Nota che lo scarto effettivo sul
parametro `shrink` fra 0.947 e 1.000 è piccolo (0.688 contro 0.710): l'effetto pratico è modesto,
la questione è di onestà del codice più che di previsione.

---

### P7 — Task 10: misurare prima di scrapare
**Costo: basso la misura, medio lo scraping · Inversione dell'ordine dato dal brief v1**

Il brief v1 metteva lo scraping delle designazioni come contenuto principale di Task 10. È
l'ordine sbagliato: `referee` è presente sul **21.5% delle gare passate**, quindi l'effetto è
misurabile **adesso, senza rete**.

Da fare:
1. cablare `refereeHomeBias` in `app.js` (il payload contiene già `referee_stats`) e il test
   "resta 0 se l'arbitro è ignoto";
2. misurare l'effetto in backtest appaiato **sul 21.5% dove l'arbitro è noto**;
3. **solo se l'effetto è distinguibile da zero**, valutare lo scraping. Se non lo è, chiudere
   Task 10 come negativo e risparmiare l'intero costo della fonte.

---

### P8 — Chiusure formali e ri-versionamento
**Costo: basso · Evita che la sessione 3 ricominci da premesse false**

1. **Chiudere Task 11.** Il suo scopo dichiarato era modulare la `k` di Task 3, che le misure
   dicono di lasciare a 1. Senza quello scopo non ha una ragione autonoma. Registrarlo come
   decaduto, non lasciarlo in coda.
2. **Produrre `BRIEF-v2.md`** che sostituisca il v1: numeri di riferimento ricalcolati sul dataset
   corrente, §2.1-§2.7 riscritte come esiti anziché come ipotesi, la famiglia di ipotesi respinte
   di §1.3 scritta come risultato acquisito, R9-R12 integrate.
3. **Consolidare `docs/misure-riferimento.md`** come unica fonte dei numeri, con la data del
   dataset accanto a ciascuno. Il brief v1 li aveva inline e sono diventati stali in una sessione.

---

## 4. Da non riaprire

Registrato come conoscenza acquisita. Riaprire uno di questi punti richiede un'evidenza nuova, non
una variante nuova.

- **Scontare la forza ereditata dalla stagione precedente** — cinque meccanismi indipendenti,
  tutti peggiorativi, monotoni nell'intensità, su finestre indipendenti (§1.3).
- **Vantaggio campo per lega o per squadra** — già interamente catturato dalle baseline di
  competizione. Il residuo per squadra che sembrava reale (1.8σ) era forza mal stimata: sparisce
  a 0.14σ al netto del residuo in trasferta.
- **`venueTilt = 0.018` come artefatto del proxy dei tiri** — ipotesi formulata e **ritirata**
  nella sessione 1. La misura che l'aveva suggerita resta valida come fatto (asimmetria xG reale
  0.409 contro 0.260 del proxy), ma l'holdout mostra che 0.018 resta il valore migliore anche
  dopo la correzione degli xG.
- **Ricalibrazione completa** — testata con split R7, peggiore sull'holdout (§R12).
- **Il possesso come feature di stile** — 14.9% di copertura anche dopo Task 1.

---

## 5. La domanda che resta aperta, e che vale più di tutta la coda sopra

Il costo di inizio stagione è reale e misurato: **log loss ~1.018 nelle prime tre giornate contro
~0.99 nel resto**, con 6 punti di accuratezza in meno. Il brief v1 aveva una spiegazione
(sovra-sicurezza sul rapporto di forza ereditato) e **quella spiegazione è falsa**.

Nessuna delle spiegazioni alternative è stata testata. Le candidate, in ordine di plausibilità:

1. **Non è un difetto del modello ma della realtà**: le prime giornate sono intrinsecamente più
   imprevedibili, e anche il mercato ci perde. **Verificabile subito con P3 segmentato**: se il
   divario modello-mercato nelle prime tre giornate è uguale a quello del resto della stagione,
   non c'è niente da correggere e il segmento va rimosso dalla lista dei problemi.
2. **È un problema di livello, non di asimmetria**: i gol totali attesi a inizio stagione, non i
   rapporti di forza. La diagnostica di fase riporta già gol attesi contro osservati per fascia —
   `2.770` contro `2.704` nella 01-03 sui numeri vecchi, da ricalcolare.
3. **È la varianza delle rose, non la loro forza media**: le squadre a inizio stagione sono più
   *disperse* attorno al proprio livello, non sistematicamente sopravvalutate. Questo richiede
   una correzione sulla forma della distribuzione, non sulla media — cioè una strada che il brief
   v1 non ha mai considerato.

**Fare P3 prima di scegliere fra queste tre.** Se l'ipotesi 1 regge, le altre due non servono.
