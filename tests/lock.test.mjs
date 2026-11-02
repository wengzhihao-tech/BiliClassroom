import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
test('iteration lock prevents overlap and another owner releasing it',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'biliclass-lock-'));const script=fileURLToPath(new URL('../scripts/iteration-lock.mjs',import.meta.url));
  const call=(...args)=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',env:{...process.env,BILICLASS_LOCK_DIR:dir}});
  try{assert.equal(call('acquire','first-run-001').status,0);assert.equal(call('acquire','second-run-002').status,2);assert.equal(call('release','second-run-002').status,2);assert.equal(call('release','first-run-001').status,0);assert.equal(call('acquire','second-run-002').status,0);}
  finally{rmSync(dir,{recursive:true,force:true});}
});
