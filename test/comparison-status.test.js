import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchServer } from '../scripts/lib/server.mjs';
import { exportSvg } from '../src/core/export-svg.js';

async function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cg-status-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['project','before','after'])fs.mkdirSync(path.join(root,dir));
  const old='int value=1; void target(void){} void caller(void){\n#if A\ntarget();\n#endif\n}';
  const now=old.replace('value=1','value=2').replace('#if A','#if B');
  for(const [dir,src]of[['project',old],['before',old],['after',now]])fs.writeFileSync(path.join(root,dir,'main.c'),src);
  const srv=await launchServer({target:path.join(root,'project')});t.after(()=>srv.close());
  const get=url=>fetch(srv.baseUrl+url).then(r=>r.json());
  const post=(url,body)=>fetch(srv.baseUrl+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const prepare=()=>post('/api/compare',{beforePath:path.join(root,'before'),afterPath:path.join(root,'after')});
  return {srv,get,post,prepare};
}

test('弹窗状态覆盖与节点/变量状态：保留自动结果，刷新可读，恢复自动且不污染原工程',async t=>{
  const {get,post,prepare}=await setup(t);
  await post('/api/overlay',{nodeId:'main.c::target',data:{change:'added'}});
  const p=await prepare();
  const applied=await post('/api/compare/apply',{previewId:p.preview.id,selectedIds:p.preview.candidates.map(n=>n.id),statusOverrides:{'var::value':'existing'}});
  assert.equal(applied.ok,true);
  const id=applied.comparison.id;
  let v=await get('/api/view');
  let value=v.nodes.find(n=>n.id==='var::value');
  assert.deepEqual([value.change,value.detectedChange,value.statusSource],['existing','modified','manual']);
  const changed=await post('/api/compare/status',{comparisonId:id,nodeId:'main.c::target',change:'modified'});
  assert.equal(changed.ok,true);
  assert.equal(changed.target.detectedChange,'existing');
  assert.equal(changed.comparison.summary.functions.modified,2);
  assert.equal((await get('/api/node?id=main.c::target')).node.change,'modified');
  v=await get('/api/view');
  assert.equal(v.nodes.find(n=>n.id==='main.c::target').statusSource,'manual');
  const auto=await post('/api/compare/status',{comparisonId:id,nodeId:'main.c::target',change:null});
  assert.deepEqual([auto.target.change,auto.target.statusSource],['existing','automatic']);
  assert.equal((await post('/api/overlay',{nodeId:'main.c::target',data:{change:'deleted'}})).ok,false);
  assert.equal((await post('/api/compare/status',{comparisonId:'old',nodeId:'var::value',change:'deleted'})).ok,false);
  assert.equal((await post('/api/compare/status',{comparisonId:id,nodeId:'var::value',change:'bad'})).ok,false);
  await post('/api/compare/exit',{});
  assert.equal((await get('/api/node?id=main.c::target')).overlay.change,'added');
});

test('同一位置的不同版本连线可独立调整，导出只用黑红，恢复后仍是自动新增/删除',async t=>{
  const {get,post,prepare,srv}=await setup(t);
  const p=await prepare();
  const applied=await post('/api/compare/apply',{previewId:p.preview.id,selectedIds:['main.c::caller','main.c::target']});
  let v=await get('/api/view');
  assert.equal(v.edges.length,2);
  const added=v.edges.find(e=>e.change==='added'),deleted=v.edges.find(e=>e.change==='deleted');
  assert.equal(added.line,deleted.line);
  assert.notEqual(added.comparisonKey,deleted.comparisonKey);
  const result=await post('/api/compare/status',{comparisonId:applied.comparison.id,edgeId:added.comparisonKey,change:'existing'});
  assert.equal(result.ok,true);
  v=await get('/api/view');
  assert.equal(v.edges.find(e=>e.comparisonKey===added.comparisonKey).change,'existing');
  assert.equal(v.edges.find(e=>e.comparisonKey===deleted.comparisonKey).change,'deleted');
  assert.match(exportSvg(v),/#2C2C2A/);
  assert.doesNotMatch(exportSvg(v),/#D89A00/);
  const html=await(await fetch(srv.baseUrl+'/api/export/html?root=main.c::caller&down=1')).text();
  assert.match(html,/#2C2C2A/);
  assert.doesNotMatch(html,/#D89A00/);
  await post('/api/compare/status',{comparisonId:applied.comparison.id,edgeId:added.comparisonKey,change:null});
  assert.equal((await get('/api/view')).edges.find(e=>e.comparisonKey===added.comparisonKey).change,'added');
});

test('无效弹窗状态在发布之前拒绝',async t=>{
  const {get,post,prepare}=await setup(t);
  const p=await prepare();
  const result=await post('/api/compare/apply',{previewId:p.preview.id,selectedIds:['main.c::caller'],statusOverrides:{missing:'modified'}});
  assert.equal(result.ok,false);
  assert.equal((await get('/api/project')).comparison,null);
});
