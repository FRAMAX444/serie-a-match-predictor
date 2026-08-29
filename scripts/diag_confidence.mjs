#!/usr/bin/env node
// L'etichetta di confidenza ordina davvero le gare per accuratezza, o e' decorazione?
//
// E' l'unica validazione possibile per una confidenza: non esiste un osservabile "questa
// previsione era affidabile" contro cui tararla, ma se l'etichetta non separa le gare per log
// loss allora non sta dicendo niente. La confidenza non entra in nessuna previsione, quindi
// questo confronto non e' circolare: le probabilita' confrontate sono identiche in tutte e tre
// le fasce.
//
//   node scripts/diag_confidence.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const { predictFromMatches } = await import(`${R}/model.js`);
const { modelInputs } = await import(`${R}/prediction-inputs.js`);
const SUP=new Set(["eng.1","esp.1","ita.1","ger.1","fra.1","ucl","uel","uecl"]);
const DOM=new Set(["eng.1","esp.1","ita.1","ger.1","fra.1"]);
const p=JSON.parse(fs.readFileSync(`${R}/data/matches.json`,"utf8"));
const all=p.matches.filter(m=>SUP.has(String(m.competition_id))&&m.home_goals!=null&&m.away_goals!=null)
  .sort((a,b)=>String(a.date).localeCompare(String(b.date)));
const rows=[];
for(const m of all){
  if(String(m.date)<"2023-08-01") continue;
  let r; try{ r=predictFromMatches(all,{...modelInputs(),homeTeam:m.home_team,awayTeam:m.away_team,date:m.date,cutoffDate:m.date,competitionId:m.competition_id,season:m.season}); }catch{ continue; }
  const a=m.home_goals>m.away_goals?0:m.home_goals===m.away_goals?1:2;
  const pr=[r.probabilities.homeWin,r.probabilities.draw,r.probabilities.awayWin];
  rows.push({label:r.confidence.label, score:r.confidence.score, ll:-Math.log(Math.max(1e-15,pr[a])),
             dom:DOM.has(String(m.competition_id))});
}
const mean=(a)=>a.reduce((s,v)=>s+v,0)/a.length;
const se=(a)=>{const m=mean(a);return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1)/a.length);};
const report=(title,sel)=>{
  console.log(`\n=== ${title} ===`);
  console.log("etichetta |    n |  quota | log loss | err.std");
  const set=rows.filter(sel); const tot=set.length;
  for(const lab of ["Alta","Media","Bassa"]){
    const v=set.filter(r=>r.label===lab).map(r=>r.ll);
    if(v.length<15){ console.log(`${lab.padEnd(9)} | ${String(v.length).padStart(4)} |  ${(100*v.length/tot).toFixed(1)}% |   (troppo poche)`); continue; }
    console.log(`${lab.padEnd(9)} | ${String(v.length).padStart(4)} |  ${(100*v.length/tot).toFixed(1).padStart(4)}% |  ${mean(v).toFixed(4)}  | ${se(v).toFixed(4)}`);
  }
};
report("tutte le competizioni", ()=>true);
report("solo campionati", (r)=>r.dom);
report("solo coppe UEFA", (r)=>!r.dom);
// il test decisivo: Alta vs non-Alta, differenza e sigma
const hi=rows.filter(r=>r.label==="Alta").map(r=>r.ll);
const lo=rows.filter(r=>r.label!=="Alta").map(r=>r.ll);
const d=mean(lo)-mean(hi); const s=Math.sqrt(se(hi)**2+se(lo)**2);
console.log(`\nAlta (${hi.length}) vs non-Alta (${lo.length}): differenza ${d.toFixed(4)} ± ${s.toFixed(4)}  -> ${(d/s).toFixed(2)} sigma`);
