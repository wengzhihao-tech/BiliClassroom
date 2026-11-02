import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
let bad=0,checked=0;
function walk(p){for(const f of readdirSync(p,{withFileTypes:true})){
  if(['runtime','.git','node_modules'].includes(f.name))continue;
  const full=path.join(p,f.name);if(f.isDirectory())walk(full);
  else if(/\.(mjs|js)$/.test(f.name)){const r=spawnSync(process.execPath,['--check',full],{encoding:'utf8'});checked++;if(r.status){console.error(r.stderr);bad++;}}
  else if(f.name.endsWith('.json')){try{JSON.parse(readFileSync(full,'utf8').replace(/^\uFEFF/,''));}catch(e){console.error(full,e.message);bad++;}}
}}
walk(fileURLToPath(root));
console.log(JSON.stringify({syntaxFiles:checked,errors:bad}));process.exitCode=bad?1:0;