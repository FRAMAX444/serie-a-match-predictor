# Pre-registrazione — prior Elo per nazione dei club di coppa

**Scritta prima di eseguire qualunque misura del meccanismo.** Data: 2026-11-10. Dataset:
`data/matches.json` del 2026-11-01 (8993 gare concluse).

## 1. Ipotesi

Nelle coppe UEFA ogni club mai visto parte da Elo 1500, qualunque sia il suo campionato: un club
portoghese e uno di Gibilterra sono indistinguibili alla prima gara. L'85% dei club di coppa (329
su 388) non ha nessuna gara di campionato nel dataset da cui correggerlo, ed è la causa misurata
della cecità del modello in Conference League (`PROMPT-sessione-5.md` §1.3: guadagno sul prior
fisso `0.0128 ± 0.0066`, 1.9σ, rimisurato il 09/11/2026).

Partire dalla forza del campionato nazionale (`league_strength` della tabella della pipeline, da
1570 a 1225, per codice nazione UEFA) dovrebbe migliorare le previsioni di coppa dove mancano i
dati domestici.

Non è nella lista «Da non riaprire» (`PROMPT-sessione-3.md` §6, `PROMPT-sessione-2.md` §4). Non è
la calibrazione di coppa respinta in §13: non tocca la calibrazione, cambia un dato di partenza.

## 2. Parametro sotto test — fissato ora

Un solo valore, nessuna griglia: `cupCountryPriorWeight = 1` (Elo di partenza = forza del
campionato nazionale) contro `0` (produzione). Nessuna stima di alcun tipo: la tabella delle
forze esiste da prima ed è scritta a mano, quindi non c'è un training da cui sovradattare.

## 3. Misura

`node scripts/diag_cup_country_prior.mjs <dataset>`: log loss 1X2 appaiato sulle stesse gare di
coppa, peso 1 meno peso 0, sulle gare dal 2023-08-01 con almeno 100 gare precedenti.

Il dataset pubblicato del 01/11 non porta ancora `*_league_strength` sulle gare storiche (la
pipeline li scarta in compattazione fino a questa modifica). La prima misura usa quindi un
dataset annotato in memoria: codice nazione di ogni club dalle fixture di coppa della stagione in
corso (dove l'API UEFA lo fornisce), forza dalla stessa tabella della pipeline. I club usciti dalle
coppe prima del 2026-27 restano senza forza, cioè a 1500 in entrambi i bracci: la misura
**sottostima** l'effetto, non lo gonfia. Va rifatta sul dataset rigenerato dalla CI.

## 4. Soglie e decisione — fissate ora

| # | misura | soglia di successo | decisione se fallisce |
|---|---|---|---|
| C1 | guadagno appaiato su tutte le gare di coppa, **holdout** (dal 2025-07-08) | **≥ +0.0020 a ≥ 2σ** | il peso resta 0; il dato resta nel dataset; la voce si chiude |
| C2 | guadagno appaiato in **UECL**, holdout | **non negativo oltre 1σ** | come C1 |
| C3 | stessa misura sul dataset rigenerato dalla CI | stesso esito di C1 | il peso torna a 0 |

Il peso va a 1 in produzione solo se C1 e C2 passano. Il training (fino al 2025-05-31) si riporta
per completezza ma non decide nulla: non c'è nulla da stimare su di esso.

## 5. Esito

Misurato il 2026-11-10 sul dataset annotato in memoria (3081 gare di coppa con almeno una forza,
3134 valutate):

```
training (fino 2025-05-31) | n=1601 | guadagno +0.0082 ± 0.0017 | 4.97σ
HOLDOUT (dal 2025-07-08)   | n=1533 | guadagno +0.0076 ± 0.0017 | 4.52σ
  holdout ucl              | n= 425 | guadagno +0.0061 ± 0.0025 | 2.41σ
  holdout uel              | n= 405 | guadagno +0.0102 ± 0.0025 | 4.01σ
  holdout uecl             | n= 703 | guadagno +0.0070 ± 0.0030 | 2.34σ
```

- **C1 superata**: +0.0076 a 4.5σ contro una soglia di +0.0020 a 2σ.
- **C2 superata**: UECL +0.0070, positivo.
- **C3 da fare** sul primo dataset rigenerato dalla CI.

Decisione, come scritta in §4: `cupCountryPriorWeight = 1` in produzione. Il prior vale solo
quando si prevede una gara di coppa, l'unico ramo che la misura ha esercitato; le previsioni di
campionato restano invariate. Fino alla rigenerazione del dataset il meccanismo è inerte, perché
le gare storiche non portano ancora `*_league_strength`.
