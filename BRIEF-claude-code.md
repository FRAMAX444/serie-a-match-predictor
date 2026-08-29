# BRIEF DI LAVORO — Evoluzione del modello di previsione (6.0 → 6.1)

> **Documento di input per Claude Code.** È autosufficiente: contiene la diagnosi, le misure di
> riferimento, gli script di diagnostica da creare, la coda di lavoro con criteri di accettazione
> verificabili, e i vincoli non negoziabili. Non richiede di leggere altri documenti.
>
> **Leggere per intero le sezioni 0 e 1 prima di scrivere una riga di codice.**

---

## 0. Regole operative non negoziabili

Queste regole vincolano ogni task di questo documento. Una modifica che ne viola anche una sola
va considerata non completata, indipendentemente dai risultati numerici che produce.

### R1 — Neutralità a parametro nullo
Ogni parametro nuovo, posto a `0` (additivo) o `1` (moltiplicativo), deve riprodurre l'output
attuale **bit per bit**. È lo standard che `newcomerEloDiscount`, `teamContext` e
`refereeHomeBias` già rispettano in `model.js`. Serve un test che lo verifichi esplicitamente per
ogni nuovo parametro.

### R2 — Il test di regressione si scrive prima, e deve fallire
Prima di modificare il codice, scrivere il test che cattura il difetto. Il test deve **fallire
sul codice attuale**. Se passa già, non sta testando ciò che si crede.

Motivo, dal `README.md` del progetto: il bug che azzerava ogni probabilità di ogni giocatore non
ha rotto nessun test, perché le fixture avevano il campo `minutes` popolato mentre la produzione
no. Un dato mancante non solleva un'eccezione: **produce silenziosamente un numero plausibile**.
Questa classe di bug è la più probabile in tutti i task qui sotto.

### R3 — Confronto appaiato obbligatorio
Mai confrontare due configurazioni eseguendo `npm run backtest` due volte e guardando i due
numeri. Misura effettiva su 768 gare di Serie A:

```
errore std APPAIATO     : 0.0002
errore std NON appaiato : 0.0154   ← 77 volte più grande
```

I miglioramenti veri in questo progetto sono dell'ordine di 0.002-0.005 di log loss. Con il
metodo non appaiato sono invisibili, e il rumore viene scambiato per segnale. Usare
`scripts/diag_paired_ab.mjs` (Task 0.2).

### R4 — Ricalibrare prima di giudicare
`DEFAULT_CALIBRATION` (`model.js:37`) è stimato da `fit_calibration.mjs` sui lambda grezzi del
modello **senza** le feature di questo documento. Qualunque modifica ai lambda cambia quella
distribuzione e rende stale la calibrazione.

Sequenza obbligatoria: `modifica → npm run fit:calibration → confronto appaiato`. Il confronto
onesto è *(modello + feature + calibrazione ristimata)* contro *(modello attuale + calibrazione
ristimata sullo stesso split)*.

### R5 — Segmentare sempre
Un guadagno aggregato che nasconde un peggioramento su un segmento non è un guadagno. Segmenti
obbligatori: **fase di stagione** (giornate 1-3 / 4-6 / 7-10 / 11-19 / 20+), **lega**,
**copertura xG**. Usare `scripts/diag_season_phase.mjs` (Task 0.1).

### R6 — Direzione dell'effetto separata dall'entità
Ogni task qui sotto ha un **criterio di direzione** (es. "la correlazione deve scendere sotto
0.3", "il coefficiente stimato deve essere negativo"). Va verificato **prima** e
**indipendentemente** dal log loss. Se la direzione è sbagliata, la modifica non sta facendo ciò
per cui è stata scritta, anche se il log loss migliora — in quel caso sta compensando un altro
errore, e va scartata.

### R7 — Holdout out-of-time mai toccato
Il dataset ha 8646 partite su quattro stagioni (`2324`, `2425`, `2526`, `2627`). **La stagione
`2526` intera è l'holdout.** Non stimare nessun parametro su di essa. Stimare su `2324`+`2425`,
validare su `2526`.

### R8 — Un cantiere alla volta
`tune_hyperparameters.mjs` cerca già su 16 dimensioni e il README segnala il rischio di
overfitting. Non aprire un task nuovo prima che il precedente abbia passato il cancello di §6.
Non stimare più parametri nuovi contemporaneamente.

---

## 1. Contesto e stato attuale

### 1.1 Il progetto

Web app statica per previsioni sui Big Five (`eng.1`, `esp.1`, `ita.1`, `ger.1`, `fra.1`) e le tre
coppe UEFA (`ucl`, `uel`, `uecl`).

- **Modello**: `model.js`, versione `6.0-shrunk-asymmetry`. Poisson bivariata con correzione
  Dixon-Coles, lambda costruiti come prodotto di potenze, calibrazione su livello/asimmetria dei
  lambda.
- **Pipeline**: `scripts/update_top5_data.py` (dataset) → `scripts/enrich_competitions_players.py`
  (`team_context`, `player_context`). Fonti: ESPN, UEFA API, Football-Data.co.uk, Understat.
- **Dataset**: `data/matches.json`, 8646 partite, 285 squadre.

### 1.2 Comandi

```bash
npm test                    # 14 suite JS
npm run test:py             # suite Python
npm run check               # syntax check
npm run backtest -- --competition ita.1
npm run backtest:market     # confronto con quote di chiusura de-vigate
npm run diagnose            # scomposizione della calibrazione
npm run fit:calibration     # ristima DEFAULT_CALIBRATION
npm run tune                # coordinate descent sugli iperparametri
```

### 1.3 Baseline da riprodurre prima di modificare qualsiasi cosa

```
npm run backtest -- --competition ita.1
  → logLoss 0.9878, RPS 0.1953, accuracy 0.526, 1000 gare (2023-12-11 → 2026-08-23)
```

Riferimenti dal README: modello 6.0 log loss **1.0151** su 3000 gare; mercato di chiusura
de-vigato **0.9985**. **Lo spazio totale disponibile è 0.017 di log loss.** Ogni task di questo
documento se ne divide una frazione. Un guadagno di 0.003 è un ottimo risultato; un guadagno di
0.02 è quasi certamente overfitting e va guardato con sospetto, non con entusiasmo.

---

## 2. Diagnosi misurata

Tutte le misure sotto sono state eseguite su `data/matches.json` (generato 2026-08-24). Vanno
riprodotte come primo passo (Task 0.3): se non si riproducono, il dataset è cambiato e i numeri
di riferimento di questo documento vanno ricalcolati prima di procedere.

### 2.1 Il costo del cambio stagione

Big Five, 3702 gare dal 2024-08-01, segmentate per giornata effettiva di stagione (la n-esima
partita stagionale della squadra meno esperta delle due):

```
fascia   |    n | logLoss | acc   | quality | P(1) oss    | P(2) oss
01-03    |  415 |  1.018  | 0.470 |  0.902  | .418 .434   | .333 .299
04-06    |  345 |  0.973  | 0.504 |  0.966  | .431 .426   | .323 .284
07-10    |  388 |  0.980  | 0.523 |  0.975  | .427 .482   | .329 .265
11-19    |  865 |  0.990  | 0.532 |  0.977  | .434 .418   | .323 .328
20+      | 1689 |  0.997  | 0.529 |  0.976  | .436 .425   | .322 .329
```

Tre letture:

1. **Le prime tre giornate costano 0.03-0.045 di log loss** e 6 punti di accuratezza rispetto al
   resto della stagione. Su 0.017 di spazio totale verso il mercato, quel segmento da solo vale
   più di tutto lo spazio disponibile — perché lo stai perdendo, non guadagnando.
2. **Il modello non se ne accorge.** `quality.score` scende solo da 0.976 a 0.902. Poiché
   `applyCalibration` (`model.js:116`) interpola `shrink` linearmente fra
   `asymmetryShrinkLowQuality = 0.30` e `asymmetryShrink = 0.71`, quel calo si traduce in una
   compressione da 0.700 a 0.670: **il modello è praticamente sicuro alla prima giornata quanto
   alla trentesima.** Il meccanismo di prudenza esiste, è calibrato, ed è inerte.
3. **Alle prime giornate sbaglia in una direzione precisa**: sovrastima la trasferta di 3.4pp,
   sottostima la casa di 1.6pp. Con n=415 l'errore std è ~2.3pp, quindi è al limite della
   significatività, ma la direzione è coerente con l'ipotesi (sta usando i rapporti di forza
   dell'anno prima).

### 2.2 Il passato non esce mai di scena, e i tempi sono incoerenti

Peso residuo della stagione precedente nelle medie del modello (pausa estiva ~95 giorni, cadenza
settimanale, half-life da `stateMetrics`, `model.js:391`):

| giornata | `gf5`/`xgFor5`/`shots5` (HL 70gg) | `ppg3` (HL 18gg) |
|---|---|---|
| 1 | 100% | 100% |
| 2 | **77.9%** | 7.6% |
| 3 | 62.0% | 3.4% |
| 5 | **40.8%** | 1.3% |
| 8 | 22.5% | 0.4% |
| 12 | 9.1% | 0.1% |

Gli esponenti di attacco (`attackExponents`) sommano a 1.00 e quelli di difesa a 1.00: alla 5ª
giornata il 41% del segnale che costruisce metà del lambda viene da una rosa che in parte non
esiste più.

Peggio dell'ampiezza è **l'incoerenza**: alla 2ª giornata il momentum è per il 92% costruito su
**una sola partita** della stagione nuova, mentre attacco e difesa sono per il 78% costruiti sulla
vecchia. Il modello sta simultaneamente sovra-reagendo a una giornata e sotto-reagendo al mercato
estivo, su termini diversi della stessa moltiplicazione.

### 2.3 L'Elo non ha un confine di stagione

`decayInactiveElo` (`model.js:279`) regredisce verso `baselineElo` solo dopo 45 giorni di
inattività, con `retention = exp(-(gap-45)/900)`. Pausa estiva di 95 giorni →
`exp(-50/900) = 0.946`. **Una squadra a 1700 riparte da 1689.**

La pratica consolidata nei sistemi Elo calcistici è una regressione del 20-35% verso la media di
lega al cambio stagione. Qui è il 5.4%.

### 2.4 Le neopromosse non sono mai riconosciute

Elo delle squadre di Serie A 2627 nel payload:

```
Inter 1700.4 · Juventus 1653.2 · Como 1646.2 · Napoli 1644.4 · Milan 1624.7 · Atalanta 1594.9
Udinese 1544.9 · Cagliari 1530.4 · Sassuolo 1523.4 · Parma 1521.3 · Torino 1520.1
Genoa 1516.2 · Lecce 1513.3 · Frosinone 1511.9 · Venezia 1493.9 · Monza 1452.2
```

Le tre neopromosse (Frosinone, Monza, Venezia) partono **alla media di lega**.

Causa: `newcomerTeams()` (`model.js:293`) identifica come "nuova" solo una squadra la cui prima
partita nella finestra coincide con la prima partita **nell'intero dataset non filtrato**.
Frosinone era in Serie A nel 2324, quindi è nel dataset, quindi **non viene mai riconosciuta come
neopromossa** — qualunque valore si metta in `newcomerEloDiscount`.

Verifica appaiata con `newcomerEloDiscount: -65`, 768 gare di Serie A dal 2024-08-01:

```
log loss base         : 0.9856
log loss variante     : 0.9854
differenza appaiata   : 0.0002 ± 0.0002
gare in cui la modifica cambia qualcosa: 87/768   (su quelle: 0.0016 ± 0.0015)
```

Il gancio esiste, è documentato, è testato, ed è inerte.

### 2.5 La "forma" è per tre quarti "forza"

`momentum` in `predictFromMatches` (`model.js:804`) è
`0.65·ppg3 + 0.35·ppg10` per la casa meno lo stesso per la trasferta. Misura su 590 gare di
Serie A dal 2025-01-01:

```
corr(EloDiff, momentum) = 0.750
sd(EloDiff) = 121.1   sd(momentum) = 0.889
```

Il termine di forma è collineare al 75% con l'Elo: il modello conta la forza due volte, una via
`eloHome/eloAway` e una via `formHome/formAway`, con clamp indipendenti (±0.34 e ±0.16) che non
si parlano.

Causa concettuale: **la forma è misurata in punti assoluti, non come scostamento dal livello
atteso della squadra.** L'Inter a 2.1 ppg è "in forma" permanentemente; il Venezia a 0.9 è "in
crisi" permanentemente. Secondo difetto: è misurata **sui punti**, il segnale più rumoroso
disponibile — uno 0-0 dominato con 2.4 xG contro 0.3 vale quanto uno 0-0 subito.

### 2.6 Copertura xG asimmetrica (il difetto più grosso e meno visibile)

```
          2324   2425   2526
ita.1      99%    90%    90%
eng.1      77%    78%    78%
fra.1      77%    76%    85%
esp.1      46%    35%    36%   ←
ger.1      34%    34%    23%   ←
```

L'esponente xG è **il più alto del modello**: `attackExponents.xg = 0.43`,
`defenseExponents.xg = 0.45`. In Bundesliga, per il 66-77% delle partite, quella feature non è un
xG ma il fallback di `xgValue()` (`model.js:229`):
`0.16 + 0.026·tiri + 0.19·tiriInPorta` — una funzione lineare di due variabili **già presenti nel
modello** con esponenti 0.18 e 0.07.

Conseguenza: in quelle leghe il modello non pesa xG 0.43 e tiri 0.25. Pesa **tiri 0.68**, con
un'etichetta diversa. Non è un bug — il fallback è documentato e onesto — è un effetto che nessuna
diagnostica aggregata può mostrare, perché il log loss medio somma leghe al 90% e leghe al 23%.

`xgCoverage` entra in `dataQuality` (`model.js:494`) con peso 0.10 su un fattore
`(0.35 + 0.65·xg)`: può muovere lo score al massimo di 0.065. Troppo poco per un difetto di
questa portata.

### 2.7 Vantaggio campo: due costanti globali contro cinque leghe in deriva

`applyMatch` usa `homeAdvantage = 48` (38 per le coppe), `DEFAULT_CALIBRATION.venueTilt = 0.018`.
Osservato sul dataset:

```
             1        X        2      gol casa  gol trasf
ita.1      0.401    0.279    0.321     1.35      1.18
eng.1      0.432    0.247    0.321     1.61      1.36
esp.1      0.455    0.267    0.278     1.48      1.15
ger.1      0.420    0.256    0.324     1.74      1.46
fra.1      0.437    0.242    0.321     1.55      1.29

league_strength: eng.1 1570 · esp.1 1555 · ita.1 1550 · ger.1 1540 · fra.1 1520
```

5.4pp di spread fra Serie A e LaLiga. E in deriva:

```
Serie A, tasso vittorie casalinghe:  2324: 0.418   2425: 0.397   2526: 0.389
```

(n=380 per stagione, errore std ~2.5pp: il calo di 2.9pp è al limite. Va misurato su tutte e
cinque le leghe prima di trattarlo come trend.)

### 2.8 Otto ganci esistenti e tutti a valore costante

| campo | dove | valore in produzione | letto da `model.js`? |
|---|---|---|---|
| `squad_continuity` | `update_europe_data.py:723` | sempre `0.85` | **no** |
| `newcomer_impact` | `update_europe_data.py:724` | sempre `0.0` | **no** |
| `departure_impact` | `update_europe_data.py:724` | sempre `0.0` | **no** |
| `manager_change_days` | `update_europe_data.py:726` | sempre `None` | **no** |
| `availability_attack/defense` | `build_team_context` | `≠1` per **0/318** squadre | sì |
| `promotion_attack/defense` | `build_team_context` | `≠1` per **0/318** squadre | sì |
| `refereeHomeBias` | `model.js:801` | sempre `0` | sì |
| `importance` | dataset | `1.0` per **tutte** le gare domestiche | sì |

`data/context_overrides.json`, l'unica fonte di `availability_*` e `promotion_*`, **non esiste nel
repository**.

Inoltre `lineup_strength` è **strutturalmente a senso unico**. Distribuzione su 318 squadre:

```
min 1.0000 · p25 1.0000 · mediana 1.0000 · p75 1.0074 · max 1.0175
223 squadre su 318 esattamente a 1.0
```

Formula in `enrich_competitions_players.py:743`:
`clamp(1 + reliability·((avgRating − 6.5)·0.018 + (startShare − 0.5)·0.035), 0.92, 1.07)`.
`avgRating` è sempre 6.5 perché ESPN espone `rating: null`; `startShare ≥ 0.5` quasi sempre perché
`probable_lineup` seleziona proprio gli undici con più presenze. **Il fattore può solo premiare,
mai punire.** E si applica solo alle 95 squadre su 285 con `player_context`, introducendo un bias
sistematico a favore delle squadre coperte dalla pipeline — che non è un effetto calcistico.

Copertura `player_context` in Serie A 2627: presenti 16 squadre, **mancano Bologna, Fiorentina,
Lazio, Roma** (quelle che non avevano ancora giocato all'ultima esecuzione). All'inizio della
stagione la copertura è al minimo esattamente quando servirebbe al massimo.

---

## 3. Task 0 — Strumenti di misura (prerequisito di tutto)

Nessun altro task può iniziare prima che questo sia completo. Senza questi strumenti le
sezioni successive non sono verificabili.

### Task 0.1 — `scripts/diag_season_phase.mjs`

Diagnostica segmentata per fase di stagione. Creare esattamente questo file:

```javascript
#!/usr/bin/env node
// Diagnostica: la qualità della previsione dipende dalla fase della stagione?
import fs from "node:fs";
import { predictFromMatches } from "../model.js";

const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const payload = JSON.parse(fs.readFileSync("data/matches.json", "utf8"));
const all = payload.matches
  .filter((m) => DOM.has(String(m.competition_id)))
  .filter((m) => m.home_goals !== null && m.away_goals !== null)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

// giornata "effettiva" per squadra: n-esima partita della squadra in quella stagione
const counter = new Map();
for (const m of all) {
  const kh = `${m.season}|${m.home_team}`;
  const ka = `${m.season}|${m.away_team}`;
  const ch = (counter.get(kh) || 0) + 1;
  const ca = (counter.get(ka) || 0) + 1;
  counter.set(kh, ch);
  counter.set(ka, ca);
  m.__phase = Math.min(ch, ca); // la più "acerba" delle due
}

const since = process.argv[2] || "2024-08-01";
const candidates = all.filter((m) => String(m.date) >= since);
const buckets = new Map();
const bucketOf = (p) => (p <= 3 ? "01-03" : p <= 6 ? "04-06" : p <= 10 ? "07-10" : p <= 19 ? "11-19" : "20+");

let done = 0;
for (const m of candidates) {
  try {
    const r = predictFromMatches(all, {
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      date: m.date,
      cutoffDate: m.date,
      competitionId: m.competition_id,
    });
    const p = [r.probabilities.homeWin, r.probabilities.draw, r.probabilities.awayWin];
    const actual = m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2;
    const key = bucketOf(m.__phase);
    const b = buckets.get(key) || { n: 0, ll: 0, acc: 0, q: 0, pHome: 0, pDraw: 0, pAway: 0, oHome: 0, oDraw: 0, oAway: 0, lam: 0, goals: 0 };
    b.n += 1;
    b.ll -= Math.log(Math.max(1e-15, p[actual]));
    b.acc += p.indexOf(Math.max(...p)) === actual ? 1 : 0;
    b.q += r.quality.score;
    b.pHome += p[0]; b.pDraw += p[1]; b.pAway += p[2];
    b.oHome += actual === 0 ? 1 : 0; b.oDraw += actual === 1 ? 1 : 0; b.oAway += actual === 2 ? 1 : 0;
    b.lam += r.lambdaHome + r.lambdaAway;
    b.goals += m.home_goals + m.away_goals;
    buckets.set(key, b);
    done += 1;
  } catch (e) { /* dati insufficienti */ }
}

console.log(`valutate ${done} gare da ${since}\n`);
console.log("fascia  |    n | logLoss | acc   | quality | P(1)  oss   | P(X)  oss   | P(2)  oss   | gol att/oss");
for (const key of ["01-03", "04-06", "07-10", "11-19", "20+"]) {
  const b = buckets.get(key);
  if (!b) continue;
  const f = (x) => (x / b.n).toFixed(3);
  console.log(
    `${key.padEnd(7)} | ${String(b.n).padStart(4)} |  ${f(b.ll)} | ${f(b.acc)} |  ${f(b.q)}  | ` +
    `${f(b.pHome)} ${f(b.oHome)} | ${f(b.pDraw)} ${f(b.oDraw)} | ${f(b.pAway)} ${f(b.oAway)} | ${f(b.lam)} ${f(b.goals)}`,
  );
}
```

**Estensione richiesta**: aggiungere due modalità di segmentazione oltre alla fase di stagione
(`--by league` e `--by xgcoverage`), perché R5 le richiede entrambe. La struttura a bucket è già
generica: serve solo parametrizzare `bucketOf`.

### Task 0.2 — `scripts/diag_paired_ab.mjs`

Confronto appaiato fra configurazioni. Creare esattamente questo file:

```javascript
#!/usr/bin/env node
// Confronto APPAIATO fra due configurazioni: stessa partita, due modelli.
import fs from "node:fs";
import { predictFromMatches } from "../model.js";

const DOM = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
const payload = JSON.parse(fs.readFileSync("data/matches.json", "utf8"));
const comp = process.argv[2] || "ita.1";
const since = process.argv[3] || "2024-08-01";

const all = payload.matches
  .filter((m) => DOM.has(String(m.competition_id)))
  .filter((m) => m.home_goals !== null && m.away_goals !== null)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const counter = new Map();
for (const m of all) {
  const ch = (counter.get(`${m.season}|${m.home_team}`) || 0) + 1;
  const ca = (counter.get(`${m.season}|${m.away_team}`) || 0) + 1;
  counter.set(`${m.season}|${m.home_team}`, ch);
  counter.set(`${m.season}|${m.away_team}`, ca);
  m.__phase = Math.min(ch, ca);
}

const cand = all.filter((m) => m.competition_id === comp && String(m.date) >= since);
const VARIANTS = {
  base: null,
  newcomer65: { newcomerEloDiscount: -65 },
};

const ll = { base: [], newcomer65: [] };
const phase = [];
for (const m of cand) {
  const row = {};
  let ok = true;
  for (const [name, hp] of Object.entries(VARIANTS)) {
    try {
      const r = predictFromMatches(all, {
        homeTeam: m.home_team, awayTeam: m.away_team, date: m.date,
        cutoffDate: m.date, competitionId: m.competition_id, hyperparameters: hp,
      });
      const p = [r.probabilities.homeWin, r.probabilities.draw, r.probabilities.awayWin];
      const a = m.home_goals > m.away_goals ? 0 : m.home_goals === m.away_goals ? 1 : 2;
      row[name] = -Math.log(Math.max(1e-15, p[a]));
    } catch { ok = false; }
  }
  if (!ok) continue;
  ll.base.push(row.base);
  ll.newcomer65.push(row.newcomer65);
  phase.push(m.__phase);
}

const n = ll.base.length;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const diff = ll.base.map((x, i) => x - ll.newcomer65[i]);
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

console.log(`competizione ${comp}, ${n} gare da ${since}`);
console.log(`log loss base        : ${mean(ll.base).toFixed(4)}`);
console.log(`log loss variante    : ${mean(ll.newcomer65).toFixed(4)}`);
console.log(`differenza appaiata  : ${mean(diff).toFixed(4)}  (positivo = la variante è migliore)`);
console.log(`errore std APPAIATO  : ${(sd(diff) / Math.sqrt(n)).toFixed(4)}`);
console.log(`errore std NON appaiato: ${(sd(ll.base) / Math.sqrt(n)).toFixed(4)}`);
const nonZero = diff.filter((d) => Math.abs(d) > 1e-9).length;
console.log(`gare in cui la modifica cambia qualcosa: ${nonZero}/${n}`);
if (nonZero) {
  const sub = diff.filter((d) => Math.abs(d) > 1e-9);
  console.log(`  su quelle: diff media ${mean(sub).toFixed(4)}, errore std ${(sd(sub) / Math.sqrt(sub.length)).toFixed(4)}`);
}
```

**Estensioni richieste**:
1. `VARIANTS` parametrizzabile da riga di comando o da un file JSON, non hard-coded;
2. bootstrap appaiato (2000 ricampionamenti) per l'intervallo di confidenza, invece del solo
   errore standard;
3. differenza appaiata **per segmento** (usare `phase`, già raccolto), non solo aggregata;
4. supporto a più di due varianti contemporaneamente.

### Task 0.3 — Riprodurre le misure di riferimento

Eseguire e verificare che i numeri di §2 si riproducano entro il rumore. Se non si riproducono, il
dataset è cambiato: ricalcolare i riferimenti e **aggiornare questo documento** prima di
proseguire.

```bash
node scripts/diag_season_phase.mjs 2024-08-01
node scripts/diag_paired_ab.mjs ita.1 2024-08-01
npm run backtest -- --competition ita.1
```

**Criterio di accettazione Task 0**: i tre comandi girano, i numeri corrispondono a §2.1, §2.4 e
§1.3, `npm test` e `npm run check` passano.

---

## 4. Coda di lavoro

Ordinata per rapporto valore/costo. **Non riordinare.** I primi sei task non richiedono nessuna
fonte dati nuova e coprono la parte misurata del problema.

---

### Task 1 — Perché LaLiga e Bundesliga non hanno gli xG
**Priorità: 1 · Costo: basso-medio · Guadagno atteso: alto · Rischio: nullo**

Non è una modifica al modello. È il presupposto perché il modello significhi qualcosa in due
leghe su cinque (§2.6).

**Da fare**:
1. Eseguire `scripts/update_top5_data.py` in locale e leggere i log di
   `scripts/understat_team_api.py`. Il README dice che segnalano esplicitamente le squadre con 0
   partite risolte;
2. Determinare se il problema è: slug Understat sbagliati per esp.1/ger.1 (dedotti dalla
   convenzione nota del sito, quindi fragili), rate limiting, il blob `datesData` non più esposto,
   o un fallback che fallisce in silenzio;
3. Correggere. Se Understat non è recuperabile per quelle leghe, documentare la ragione e
   valutare una fonte alternativa.

**Criteri di accettazione**:
- copertura xG di `esp.1` e `ger.1` sopra il 70% sulla stagione `2526`, oppure una spiegazione
  scritta di perché non è ottenibile;
- test che fallisce se la copertura xG di una qualsiasi lega scende sotto una soglia (regressione:
  oggi non esiste nulla che se ne accorga);
- `npm run diagnose` segmentato per copertura xG **prima** e **dopo**, per quantificare l'effetto.

**Nota**: questo task va fatto per primo anche perché tutti i successivi vengono valutati con un
backtest che, per due quinti del dataset, poggia su un proxy dei tiri. Migliorare l'input prima di
migliorare il modello.

---

### Task 2 — `dataQuality` consapevole della stagione
**Priorità: 2 · Costo: basso · Guadagno atteso: medio-alto · Rischio: basso**

È la modifica che richiede meno codice nuovo e attiva un meccanismo **già calibrato e
attualmente inerte** (§2.1 punto 2).

**Problema**: `dataQuality` (`model.js:494`) è dominato da
`depth = clamp((home.matches + away.matches)/20, 0, 1)`, dove `matches` è la coda di 40 partite
che attraversa l'estate. Da qui il `0.902` alla prima giornata invece di un valore vicino a 0.

**Da fare**: introdurre una componente `seasonFreshness` — quale quota della **massa di peso**
delle medie proviene dalla stagione corrente. Il modello può calcolarla esattamente: conosce le
date di ogni record in `state.matches` e le half-life. Alla prima giornata vale 0.

Aggiungerla a `dataQuality` con peso da stimare, sottraendolo alle componenti esistenti in modo
che lo score resti in [0, 1].

**Criteri di accettazione**:
- **direzione (R6)**: `quality.score` medio nelle giornate 1-3 deve scendere sotto **0.6**
  (oggi 0.902). Verificare con `diag_season_phase.mjs` prima di guardare il log loss;
- **neutralità (R1)**: con peso 0 sulla nuova componente, output identico bit per bit;
- log loss del segmento 01-03 in miglioramento nel test appaiato; segmenti 11-19 e 20+ **non
  peggiorati** oltre l'errore standard;
- `npm run fit:calibration` rieseguito (R4): questa modifica cambia la compressione su *tutte* le
  partite, non solo quelle di inizio stagione.

---

### Task 3 — Regressione dell'Elo al confine di stagione
**Priorità: 3 · Costo: medio · Guadagno atteso: alto · Rischio: basso**

**Problema**: §2.3. Un solo meccanismo (`decayInactiveElo`) copre due fenomeni distinti.

**Da fare**: separarli.
- *inattività* (una squadra che non gioca per calendario) → resta l'attuale
  `exp(-(gap-45)/900)`;
- *cambio stagione* (rosa nuova, allenatore nuovo, obiettivi nuovi) → regressione one-shot verso
  la media della **lega di destinazione**: `elo ← mediaLega + k·(elo − mediaLega)`.

Vincoli di progetto:
- **la media di destinazione non è 1500.** `league_strength` vale 1570/1555/1550/1540/1520 (§2.7).
  Una squadra che cambia lega deve regredire verso la media giusta;
- **rilevare il confine dal campo `season`**, non da "sono passati N giorni". Il campo esiste in
  ogni match. La regola per giorni confonde estate e sosta invernale;
- `k` è un iperparametro nuovo in `DEFAULT_HYPERPARAMETERS`, **default 1.0** (nessun effetto, R1).
  Stimarlo con `tune_hyperparameters.mjs` valutando **solo sul segmento giornate 1-6**.
  Aspettativa da letteratura: `k ≈ 0.70`. Non è un valore da inserire a mano: è l'ipotesi da
  verificare.

**Criteri di accettazione**:
- **direzione (R6)**: una squadra a Elo 1700 che chiude il `2526` e apre il `2627` deve avere un
  Elo di apertura **strettamente compreso** fra la media di lega e 1700, e il valore deve
  **cambiare** se cambia `k`. Il bug simmetrico da bloccare con un test è che il confine non venga
  rilevato e la regressione non si applichi mai — cioè esattamente ciò che succede oggi a
  `newcomerEloDiscount`;
- neutralità a `k = 1.0` (R1);
- guadagno appaiato sul segmento 01-06 significativo (≥ 2 errori standard);
- `npm run fit:calibration` rieseguito.

---

### Task 4 — Neopromosse riconosciute dal calendario, non dal dataset
**Priorità: 4 · Costo: medio · Guadagno atteso: alto sul segmento · Rischio: basso**

**Problema**: §2.4. `newcomerTeams()` usa la definizione sbagliata.

**Da fare**: riscrivere `newcomerTeams()` (`model.js:293`). La definizione corretta non è "prima
apparizione assoluta" ma **"non era in questa competizione nella stagione precedente"** —
informazione già nel dataset, perché ogni partita porta `competition_id` e `season`.

Distinguere tre casi con prior diversi:
1. **promossa** (era in una lega inferiore o assente): prior sotto la media di lega;
2. **retrocessa dalla lega superiore** (raro nei Big Five);
3. **rientrata dopo assenza** (il caso Frosinone): l'Elo di due anni fa esiste ma è vecchio. Serve
   una regressione funzione degli anni di assenza — l'attuale `exp(-(gap-45)/900)` dopo 800 giorni
   lascia ancora il 43% dello scostamento.

**Il prior per lega si stima dal dataset esistente**: calcolare, sulle stagioni `2324`-`2425`
(non `2526`, che è holdout — R7), il rendimento delle squadre alla loro prima stagione in
ciascuna lega. Sono ~3 squadre × 5 leghe × 2 stagioni ≈ 30 osservazioni: sufficienti per stimare
cinque numeri **con shrinkage verso un valore comune**, non per stimarli indipendentemente.
Stimarli indipendentemente su 6 osservazioni ciascuno è overfitting garantito.

**Criteri di accettazione**:
- **direzione (R6)**: Frosinone, Monza e Venezia devono essere riconosciute come non-continue in
  `ita.1 2627`. Test esplicito su questi tre nomi;
- il numero di gare toccate dal parametro deve salire da 87/768 a un valore coerente con il numero
  di neopromosse (~15% delle gare di una stagione coinvolge almeno una neopromossa);
- neutralità a `newcomerEloDiscount = 0` (R1);
- guadagno appaiato significativo sul segmento giornate 01-10.

---

### Task 5 — Vantaggio campo per lega e per squadra
**Priorità: 5 · Costo: basso · Guadagno atteso: medio · Rischio: basso**

**Problema**: §2.7. Due costanti globali (`homeAdvantage = 48` in `applyMatch`,
`venueTilt = 0.018` in `DEFAULT_CALIBRATION`) contro cinque leghe con 5.4pp di spread e un
possibile trend in calo.

**Da fare**:
1. vantaggio campo **per lega**, stimato con shrinkage verso il valore comune;
2. vantaggio campo **per squadra**, con shrinkage forte (poche partite in casa per squadra per
   stagione: ~19, quindi il segnale individuale è debole e va compresso molto);
3. **prima di entrambi**: misurare il trend temporale su tutte e cinque le leghe. Se il calo è
   reale, una costante stimata su tre stagioni è la media di un fenomeno in deriva, e va
   affrontata con una half-life sulla stima, non con un valore fisso.

Parte dell'effetto è già catturata dalle baseline `league.homeGoals/awayGoals`
(`weightedCompetitionAverages`, per competizione): **verificare quanto residuo resta** prima di
aggiungere parametri. Se il residuo per lega è dentro il rumore, questo task si chiude senza
modifiche ed è comunque un risultato.

**Criteri di accettazione**:
- neutralità con vantaggio per-lega posto al valore globale (R1);
- calibrazione marginale su `1`/`X`/`2` **per lega** (non aggregata) migliorata in `npm run diagnose`;
- il termine per-squadra non deve superare in ampiezza quello per-lega: se lo fa, lo shrinkage è
  troppo debole.

---

### Task 6 — Impegno europeo infrasettimanale in `restFactor`
**Priorità: 6 · Costo: molto basso · Guadagno atteso: basso · Rischio: nullo**

`restFactor` (`model.js:485`) conosce solo i giorni di riposo, con quattro soglie. Il dataset sa
già **quale competizione** una squadra ha giocato mercoledì, perché ogni match porta
`competition_id`.

**Da fare**: distinguere "4 giorni di riposo dopo una partita di campionato" da "4 giorni di
riposo dopo una trasferta di Champions". Aggiungere anche il caso cumulativo "terza partita in
otto giorni", che è un effetto diverso dal singolo intervallo.

**Criteri di accettazione**: neutralità a fattore 1 (R1); direzione dell'effetto stimato negativa
(un impegno europeo non può aumentare il rendimento successivo — se il coefficiente stimato è
positivo, il task fallisce indipendentemente dal log loss).

---

### Task 7 — Forma come residuo, ortogonale all'Elo
**Priorità: 7 · Costo: medio · Guadagno atteso: medio · Rischio: medio**

**Problema**: §2.5. `corr(EloDiff, momentum) = 0.750`.

**Da fare**: ridefinire il momentum come **scostamento del rendimento osservato dal rendimento
atteso della squadra stessa**:

```
forma = Σ pesi · (punti_ottenuti − punti_attesi)
```

I punti attesi vanno calcolati retrospettivamente per ogni partita recente. Il modo economico è
salvarli nello stato dentro `applyMatch()`, dove i lambda di quella partita non sono disponibili:
approssimarli con la forma chiusa già presente (`expectedHome`, la logistica su differenza di Elo)
è più che sufficiente e non introduce dipendenze circolari.

Affiancare (non sostituire) una forma su **xG − xGA rispetto all'atteso**: distingue la squadra
che gioca bene e non raccoglie da quella che sta scendendo di livello. **Attenzione al doppio
conteggio**: `xgFor5`/`xgAgainst5` sono già nel lambda con esponente 0.43/0.45. La forma corretta
è il **residuo** (xG osservato meno xG atteso date le due squadre), non il livello.

**Criteri di accettazione**:
- **direzione (R6), da verificare per prima**: `corr(EloDiff, momentum)` deve scendere **sotto
  0.30** (oggi 0.750). Se non ci scende, la modifica non ha fatto ciò che doveva e va rivista
  prima di misurarne il log loss;
- neutralità a `momentumScale = 0` (R1);
- verificare che il clamp `momentumClamp` sia ancora tarato: cambiando la scala della variabile, un
  clamp a ±0.16 può diventare inattivo o vincolante ovunque. Ristimarlo.

---

### Task 8 — Sovra-rendimento rispetto agli xG
**Priorità: 8 · Costo: basso · Guadagno atteso: basso-medio · Rischio: basso**

`gf5` e `xgFor5` sono entrambi nel modello con esponenti positivi, ma nessun termine cattura il
**rapporto** fra i due — il segnale classico di regressione alla media. Oggi il modello, avendo
entrambe con esponente positivo, **premia** la sovra-performance invece di scontarla.

**Da fare**: un singolo termine `(gf5/xgFor5)^γ`, `γ` nuovo iperparametro, **default 0**.

**Criteri di accettazione**:
- **direzione (R6)**: l'aspettativa teorica è `γ < 0`. Se la stima risulta positiva, l'ipotesi di
  regressione alla media non regge su questi dati: **documentarlo e chiudere il task senza
  merge**. È un test pulito e il risultato negativo è informativo;
- il task ha senso solo dove gli xG sono reali: valutarlo **escludendo** le partite con xG da
  proxy, altrimenti si sta stimando `(gol/f(tiri))^γ`, che è un'altra cosa. Dipende quindi da
  Task 1.

---

### Task 9 — Rossi precoci fuori dalle medie
**Priorità: 9 · Costo: basso · Guadagno atteso: basso · Rischio: nullo**

Una squadra rimasta in dieci al 20' produce 70 minuti di dati che il modello registra come
prestazione normale. I cartellini rossi sono nel dataset al 64.1%.

**Da fare**: in `applyMatch`, escludere o pesare meno le partite con rosso precoce quando si
costruiscono i record che alimentano le medie. **Nessun parametro libero da overfittare** oltre
la soglia del minuto (e il minuto del rosso non è nel dataset: va approssimato o il task si limita
a un peso ridotto per l'intera partita).

**Criteri di accettazione**: neutralità a peso 1 (R1); nessun peggioramento su nessun segmento.
Il guadagno atteso è piccolo, quindi il criterio è "non peggiora", non "migliora
significativamente".

---

### Task 10 — Designazioni arbitrali
**Priorità: 10 · Costo: medio · Guadagno atteso: basso-medio · Rischio: basso**

`referee_stats` è già calcolato con shrinkage bayesiano (34 arbitri, `home_bias` e `avg_cards`),
`refereeHomeBias` è già un parametro di `predictFromMatches` con clamp a ±0.12, e non viene mai
usato perché nessuna fonte espone l'arbitro di una partita futura.

La designazione arbitrale è **pubblica 2-3 giorni prima** in tutti e cinque i campionati. È un
problema di scraping, non di modello: l'infrastruttura lato modello è completa e testata.

**Criteri di accettazione**: il campo `referee` popolato per le fixture future in almeno un
campionato; `refereeHomeBias` passato automaticamente da `app.js`; verifica che il valore resti 0
quando l'arbitro è ignoto.

---

### Task 11 — Continuità di rosa che modula Task 3
**Priorità: 11 · Costo: medio-alto · Guadagno atteso: medio · Rischio: medio**

**Da fare**: calcolare una **continuità di minuti** — quale quota dei minuti giocati nella
stagione precedente è ancora in rosa. È il proxy standard per "quanto questa squadra è ancora la
squadra dell'anno scorso".

**L'uso corretto non è un moltiplicatore sul lambda** ma un modulatore di `k` in Task 3:
continuità alta → l'Elo passato è informativo → `k` alto; continuità bassa → `k` basso. Questo
sostituisce una costante con una funzione invece di aggiungere un parametro moltiplicativo libero,
che overfitta facilmente.

**Vincolo di realtà**: `player_context` copre 95 squadre su 285 e in Serie A 2627 mancano proprio
le squadre che non avevano ancora giocato (§2.8). All'inizio della stagione la copertura è al
minimo esattamente quando servirebbe al massimo. **La continuità va quindi calcolata dai roster**
(che `enrich_competitions_players.py` già interroga per i ruoli, in `squad_positions()`), non
dalle presenze.

**Criteri di accettazione**: `squad_continuity` in `team_context` deve avere varianza reale fra le
squadre (oggi è la costante `0.85` per tutte e 318 — §2.8); test che fallisce se torna costante;
neutralità quando la continuità è massima.

---

### Task 12 — Fonte per infortuni e formazioni
**Priorità: 12 · Costo: alto · Guadagno atteso: alto · Rischio: medio**

Questo è il contenuto informativo reale che di solito si cerca sotto il nome "sentiment", ed è il
limite già dichiarato nel README.

**L'infrastruttura lato modello esiste già ed è completamente inutilizzata**:
`availability_attack`, `availability_defense` in `team_context`, lette da `attackContext` e
`defenseContext` in `model.js`, con clamp [0.75, 1.20] — e `≠ 1` per **0 squadre su 318** perché
`data/context_overrides.json` non esiste.

**Prerequisito**: Task 13 (`lineup_strength` bidirezionale). Un fattore di disponibilità che può
solo premiare è peggio di nessun fattore.

**Criteri di accettazione**: una fonte con timestamp verificabile; un backtest che dimostri
l'assenza di leakage temporale (la notizia deve essere anteriore al fischio d'inizio, non alla
data di pubblicazione dell'URL corrente); guadagno appaiato significativo.

---

### Task 13 — `lineup_strength` bidirezionale
**Priorità: alta se si fa Task 12, altrimenti "spegnerlo"**

**Problema**: §2.8. Distribuzione [1.0000, 1.0175], 223 squadre su 318 esattamente a 1.0,
strutturalmente incapace di scendere sotto 1, applicato solo alle 95 squadre coperte da
`player_context`.

**Da fare**: ancorarlo alla rosa di riferimento della squadra invece che al valore assoluto 1:
`forza(undici probabile) / forza(undici tipo recente)`. Sopra 1 quando gioca la formazione
migliore, sotto 1 quando mancano titolari. Con `rating: null` da ESPN, la "forza" va costruita dai
minuti e dal contributo — i campi `impact` e `start_probability` esistono già in `player_context`.

**Nel frattempo**: finché resta a senso unico è **preferibile spegnerlo** (non passare
`teamContext` da `app.js`, o clamparlo a 1). Un fattore che si applica solo a un terzo delle
squadre e solo in una direzione introduce un bias sistematico a favore delle squadre coperte dalla
pipeline, che non è un effetto calcistico.

**Criteri di accettazione**: distribuzione osservata con mediana ≈ 1.0 e **coda su entrambi i
lati**; test che fallisce se il minimo osservato su tutte le squadre è ≥ 1.0.

---

### Task 14 — Interazione di stile (un solo parametro)
**Priorità: 14 · Costo: medio · Guadagno atteso: incerto · Rischio: alto**

**Premessa strutturale che va capita prima di iniziare**: il lambda è un prodotto di potenze, cioè
**additivo in coordinate logaritmiche**. Un modello additivo non può, per costruzione,
rappresentare un'interazione: se la squadra A è vulnerabile *specificamente* contro il gioco della
squadra B, quell'effetto è un termine `f(stileA, stileB)` che non si fattorizza in `g(A)·h(B)`.

Conseguenza: **aggiungere feature di stile alle squadre non serve a niente** se poi entrano nel
prodotto come tutti gli altri fattori. Serve un termine di interazione esplicito.

**Cosa è misurabile con i dati attuali**:

| campo | copertura | usabile? |
|---|---|---|
| tiri, tiri in porta | 64.1% | sì |
| corner | 64.1% | proxy debole di palle inattive |
| cartellini | 64.1% | proxy di aggressività |
| **possesso** | **9.1%** (13-17% nei Big Five) | **no** |

Il possesso, la dimensione di stile più ovvia, **non c'è**: con quella copertura non si raggiungono
mai le ~15 partite per squadra necessarie a una stima stabile. Non ci sono dati per pressing
(PPDA), linea difensiva, field tilt, transizioni: richiedono una fonte di tocchi/posizione.

**Proposta minima difendibile** — un solo termine, sul totale gol:

```
λtotale ← λtotale · exp(β · z(volumeCasa) · z(volumeTrasferta))
```

dove `volume = tiri + tiri subiti` per partita. Due squadre che giocano partite ad alto volume
producono più gol del prodotto dei loro effetti individuali. Agisce sul **livello**, dove per la
diagnostica esistente c'è meno segnale sfruttato (`levelShrink = 0.45` dice che lo scostamento sul
totale gol viene preso a meno di metà).

**Criteri di accettazione**:
- un solo parametro `β`, default 0 (R1);
- se `β` stimato **non è distinguibile da zero** nel test appaiato: **chiudere il task, non
  merge**, e documentare. È una risposta valida, ottenuta in due giorni invece che in due mesi;
- **non aggiungere una seconda interazione** prima che la prima abbia passato l'holdout. Con 3-4
  assi di stile e le loro interazioni si arriva a 10-16 parametri liberi in più: le interazioni
  hanno meno segnale dei termini principali e più modi di sembrare significative per caso.

---

### Task 15 — Sentiment testuale (news/social)
**Priorità: ultima · Costo: alto · Guadagno atteso: probabilmente nullo · Rischio: alto**

Va tenuto in coda con una valutazione onesta, non scartato: se lo si vuole fare, va fatto in
questo ordine e accettando in anticipo l'esito probabile.

**Perché il rapporto valore/costo è cattivo**:
- *è derivato*: il sentiment su una squadra è in gran parte funzione dei risultati recenti, che il
  modello ha già. La parte non ridondante è piccola;
- *arriva già scontato*: quando una notizia genera volume testuale è già nelle quote, quindi non
  dà vantaggio sul mercato — che è la sola cosa che conta;
- *è tossico per il backtest*: costruire una serie storica di sentiment senza contaminazione
  temporale è difficile (gli archivi vengono aggiornati, gli articoli riscritti, le date sono
  quelle di pubblicazione dell'URL corrente). Un leakage anche piccolo produce un backtest
  entusiasmante e un modello inutile in produzione. **È il rischio da sottovalutare di meno**;
- *ha copertura asimmetrica*: molto testo su Inter, Real e Bayern, quasi niente su Frosinone e
  Le Havre — proprio le squadre dove il modello è più incerto.

**Se lo si fa comunque, l'unico ordine sensato**:
1. misurare il **residuo verso il mercato** (`backtest_vs_market.mjs`) per segmento. Dove il
   modello è già allineato al mercato, il sentiment non può aiutare per definizione;
2. isolare un segmento dove il modello **perde sistematicamente**. Le prime tre giornate sono il
   candidato ovvio (§2.1);
3. solo su quel segmento, raccogliere il testo con timestamp certificati, **archiviati localmente,
   mai ri-scaricati**. Una raccolta prospettica di sei mesi vale più di un archivio retrospettivo
   di cinque anni;
4. valutare con il test appaiato.

---

## 5. Statistiche in lista d'attesa (non pianificate, motivate)

Non sono task. Sono voci che vanno tenute nella lista con la ragione per cui non sono in coda.

| Statistica | Perché non ora |
|---|---|
| **Palle inattive** | La componente più persistente del rendimento offensivo (dipende da altezza e schemi, non dalla condizione). Con i dati attuali si approssima solo via corner, che misurano la *quantità* di palle inattive, non l'*efficacia*. Serve una fonte con i gol per origine. |
| **Portiere (PSxG − xG)** | Una delle poche componenti individuali con effetto misurabile a livello di squadra; un cambio di portiere sposta davvero il lambda difensivo. Dato non presente in nessuna fonte attuale. |
| **Stato del punteggio** | Una squadra in vantaggio concede tiri e xG che non riflettono il suo livello difensivo. `xG a parità di punteggio` è più predittivo. Richiede dati per intervallo, non disponibili. |
| **Distanza di viaggio** | Rilevante in LaLiga e Ligue 1 più che in Serie A. Richiede le coordinate degli stadi: dato statico, facile da procurare, va insieme al meteo. |
| **Meteo** | Pioggia e vento riducono i gol attesi e aumentano la varianza. API gratuite, servono le coordinate degli stadi. Effetto piccolo ma pulito e con segno noto in anticipo, quindi poco overfittabile. |
| **Posta in gioco** | `importance` è un campo pronto e vuoto (`1.0` per tutte le gare domestiche). Casi con effetto documentato: squadre già salve/retrocesse a fine stagione, finali europee imminenti, derby. Pochi casi per stagione → effetto aggregato piccolo per costruzione, ma sono i casi in cui il modello sbaglia in modo **visibile all'utente**. |
| **Cambio allenatore** | `manager_change_days` è nel payload, sempre `None`. L'effetto "rimbalzo" è documentato ma piccolo e in buona parte spiegabile con la regressione alla media (si esonera dopo risultati sotto le attese, che sarebbero comunque rientrati). **Da trattare con scetticismo**: è il tipo di effetto che appare nei backtest e scompare in produzione. |
| **Struttura della rosa** | Età pesata per minuti, concentrazione dei minuti, profondità per reparto. Predittori deboli del singolo risultato ma buoni **modulatori dell'incertezza**. Il posto giusto non è il lambda ma `dataQuality`. |
| **Doppio conteggio dei tiri** | `gf5`, `xgFor5`, `sot5`, `shots5` sono quattro misure correlate della stessa cosa, con esponenti che sommano a 0.90, **moltiplicate** e non combinate. Vale la pena misurare la matrice di correlazione dei quattro rapporti normalizzati: se una o due componenti spiegano il 90% della varianza, il modello ha meno gradi di libertà effettivi di quanti ne dichiari — informazione che cambia il modo di leggere ogni tuning. Analisi, non modifica. |

---

## 6. Il cancello — checklist per ogni pull request

Nessuna eccezione, incluse le modifiche che sembrano ovviamente giuste.

- [ ] **R1** Neutralità a parametro nullo verificata da un test, output identico bit per bit
- [ ] **R2** Test di regressione scritto *prima*, verificato che fallisse sul codice pre-modifica
- [ ] **R6** Criterio di direzione del task verificato **prima** di guardare il log loss
- [ ] **R4** `npm run fit:calibration` rieseguito dopo la modifica
- [ ] **R3** Confronto appaiato con errore standard (non due `npm run backtest` a confronto)
- [ ] **R5** Risultato segmentato per fase di stagione, lega e copertura xG
- [ ] **R7** Validato su holdout `2526`, mai usato per stimare nulla
- [ ] `npm test`, `npm run test:py`, `npm run check` verdi
- [ ] Il commento nel codice spiega **perché**, con il numero misurato, non **cosa** (è lo stile
      già presente in `model.js`: ogni costante ha accanto la misura che la giustifica)

---

## 7. Cosa non fare

**Non ottimizzare tutto insieme.** `tune_hyperparameters.mjs` cerca già su 16 dimensioni e il
README segnala il rischio. Aggiungere stile e sentiment porterebbe a 25-30 parametri su ~3700
osservazioni utili per lega. A quel punto il backtest misura la capacità della ricerca di trovare
rumore, non la qualità del modello.

**Non usare le quote di chiusura come input del modello.** Sono nel dataset al 60.9% e sono di gran
lunga il segnale più forte disponibile — ma un modello che le usa **smette di essere un modello di
previsione e diventa un modello del mercato**. `backtest_vs_market.mjs` confronterebbe il mercato
con sé stesso. Uso legittimo: **diagnostica**. Le partite dove il modello si discosta molto dal
mercato sono quelle dove o si è trovato qualcosa o manca un'informazione; analizzare quel residuo
è probabilmente il modo più veloce per scoprire *quale* feature manca, e non richiede niente di
nuovo.

**Non trattare i campi già presenti come se funzionassero.** Otto ganci esistenti, documentati,
testati, e tutti a valore costante in produzione (§2.8). Prima di aggiungerne di nuovi vale la
pena chiedersi perché quelli esistenti non sono mai stati collegati. La risposta, quasi sempre, è
che manca la fonte dati, non il codice — ed è lì che va il tempo.

**Non marcare un bug come risolto senza il test di regressione che l'avrebbe intercettato prima.**
È il principio già adottato in questo progetto e vale integralmente per tutto quanto sopra.
