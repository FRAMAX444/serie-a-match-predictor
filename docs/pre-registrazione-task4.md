# Pre-registrazione — decisione su Task 4 (prior delle neopromosse)

**Scritta prima di eseguire il test.** Data: 2026-08-25. Dataset: `data/matches.json`, 8403 gare,
rigenerato dopo la correzione degli alias di Task 1.

Esiste per una ragione precisa: il prior delle neopromosse è il segnale positivo più forte trovato
nella sessione 1, ed è positivo **ovunque** ma significativo **solo in training**. Riaprirlo
guardando i numeri e decidendo dopo è il modo standard di trasformare rumore in convinzione. Quindi
la regola si fissa adesso e si accetta l'esito, qualunque sia.

---

## 1. Ipotesi

Una squadra che entra in una competizione dopo un'assenza è più debole della media di quella
competizione, e il modello oggi non lo sa: le assegna 1500 (o l'Elo stantio di due stagioni prima).

## 2. Verifica preliminare di R7 — **eseguita, esito positivo**

Il prior è stato stimato **sulla sola stagione `2425`** (14 neopromosse, 5 leghe, 512 gare-squadra).
Verificato programmaticamente: nessuna squadra della stagione `2526` entra nella stima. R7 è
rispettato e la validazione sull'holdout è legittima.

Misura collaterale, registrata qui perché cambia le attese e non deve sembrare una scoperta
successiva: sulle 14 neopromosse dell'holdout `2526` il divario reale è **−82.3 Elo**, contro i
−127.6 stimati su `2425`. Il fenomeno è confermato fuori campione — le neopromosse sono nettamente
sotto il campo in entrambe le stagioni — ma **l'ampiezza varia molto** fra una stagione e l'altra
con 14 squadre per stagione. Il prior stimato su `2425` è quindi probabilmente **troppo aggressivo**
per `2526`, e questo è noto **prima** del test.

## 3. Parametri sotto test — fissati ora, non modificabili dopo

Prior per lega, con shrinkage verso il valore comune (peso di lega `n/(n+400)`, cioè fra 0.15 e
0.22: shrinkage forte come impone il brief v1 con 2-3 osservazioni per lega). Stimati su `2425`:

```json
{ "eng.1": -151, "esp.1": -128, "ita.1": -117, "ger.1": -129, "fra.1": -118, "default": -128 }
```

con `newcomerEloAnchor: 1` (ancora sulla media della lega di destinazione) e
`newcomerEloRetention: 1` (nessuna regressione per anzianità dell'assenza — quel sotto-caso è già
stato misurato e peggiora, e non va ritentato).

Una sola configurazione. **Non verranno provate varianti** finché questa non ha dato il suo esito.

## 4. Finestra di valutazione

- Tutte e cinque le leghe insieme, non solo `ita.1`.
- Tutte le stagioni fuori dal training: `--since 2025-07-08` senza limite superiore, quindi `2526`
  **e** la parte disponibile di `2627`. Quest'ultima è composta quasi solo da gare di inizio
  stagione, cioè proprio il segmento sotto esame, e ignorarla sarebbe buttare via il campione più
  informativo che esiste.

## 5. Metrica e criterio — fissati ora

- **Metrica**: differenza di log loss appaiata (R3), variante meno base, positiva se la variante è
  migliore.
- **Segmento primario**: giornate **01-10** (fasce `01-03`, `04-06`, `07-10` messe insieme).
- **Soglia**: la differenza appaiata sul segmento primario deve superare **2 errori standard**.
- **Campione minimo**: almeno **400 gare** nel segmento primario. Sotto quella soglia il test non è
  informativo e l'esito è "rinviato", non "negativo".
- **Vincolo di non peggioramento**: nessun altro segmento (`11-19`, `20+`) deve peggiorare di più
  di 2 errori standard. Un guadagno di inizio stagione pagato con una perdita altrove non è un
  guadagno.

## 6. Decisione, per ciascun esito possibile

| esito sul segmento 01-10 | decisione |
|---|---|
| ≥ +2σ e nessun segmento peggiorato oltre 2σ | **attivare** il prior per lega come default, poi eseguire R4/R12 (ricalibrare, adottare solo se batte l'attuale sull'holdout) |
| fra 0 e +2σ | **non attivare.** Registrare come "direzione confermata, ampiezza non stimabile con questo campione". Il codice resta, con la misura scritta accanto (R10) |
| negativo | **non attivare**, e chiudere Task 4 come respinto insieme agli altri della famiglia di §1.3 |
| campione < 400 gare | **rinviato**, non deciso: ripetere quando `2627` sarà più completa |

## 7. Cosa non farò

- Non proverò altri valori del prior dopo aver visto il risultato. Se −128/per-lega non passa, non
  passa: cercare il valore che passa sull'holdout **è** usare l'holdout per stimare, cioè violare R7
  aggirandolo.
- Non cambierò il segmento primario dopo aver visto i numeri.
- Non riaprirò `newcomerEloRetention`: già misurato, peggiora su entrambe le finestre, ed è il
  quinto membro della famiglia di ipotesi respinte.
- Non tratterò un risultato a 1.9σ come "quasi significativo". La soglia è 2σ ed è stata scelta
  prima di guardare.

---

# ESITO — scritto dopo l'esecuzione, 2026-08-25

Comando: `node scripts/diag_paired_ab.mjs all 2025-07-08 --variants variants_p4.json --by phase`

```
gare valutate: 1792 (holdout 2526 + parte di 2627)
gare toccate dal meccanismo: 1792/1792 (100.0%)
differenza appaiata aggregata: +0.0004 ± 0.0004   IC 95% [-0.0005, +0.0012]

per fascia:
  01-03  |  185 |  +0.0013 ± 0.0016
  04-06  |  143 |  -0.0002 ± 0.0020
  07-10  |  192 |  +0.0024 ± 0.0019
  11-19  |  435 |  +0.0003 ± 0.0009
  20+    |  837 |  -0.0002 ± 0.0004
```

**Segmento primario 01-10, come pre-registrato:**

```
gare       : 520      (minimo richiesto 400 -> soddisfatto, l'esito NON è "rinviato")
differenza : +0.00129
errore std :  0.00106
sigma      :  1.22    (soglia richiesta 2.00)
```

Vincolo di non peggioramento: rispettato (`11-19` +0.0003, `20+` −0.0002 ± 0.0004, cioè −0.5 sigma).

## Decisione applicata

Riga della tabella §6: **"fra 0 e +2σ → non attivare"**.

`newcomerEloDiscount` resta **0**. Registrato come: **direzione confermata, ampiezza non stimabile
con questo campione.**

Tre osservazioni, per chi riprenderà il punto:

1. La direzione è confermata quattro volte in modo indipendente — prior misurato −127.6 Elo su
   `2425`, −82.3 Elo su `2526`, differenza appaiata positiva su train (+0.0011, IC che esclude lo
   zero) e positiva su holdout (+0.0004). **Che le neopromosse siano più deboli non è in
   discussione.** Ciò che non regge è la stima dell'ampiezza.
2. La ragione probabile è nei numeri: il prior vero varia da −128 a −82 fra due stagioni
   consecutive, con 14 squadre per stagione. Non è rumore di misura, è **variazione reale
   dell'annata**, e nessun valore fisso la cattura.
3. Il criterio di campione minimo era soddisfatto (520 gare), quindi **questo non è un rinvio per
   mancanza di dati**: è un risultato. Ripeterlo con `2627` completa darebbe più potenza, ma il
   passaggio da 1.22 a 2.00 sigma richiederebbe circa 2.7 volte il campione attuale.

## Cosa non è stato fatto, deliberatamente

Non ho provato altri valori del prior dopo aver visto il risultato, non ho cambiato il segmento
primario, e non ho trattato 1.22 sigma come "promettente". Erano i tre impegni presi in §7.
