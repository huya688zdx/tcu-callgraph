import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readBuildConfigFile, scanBuildConfig } from '../src/core/build-inspect.js';
import { launchServer } from '../scripts/lib/server.mjs';

function makeMultiCoreFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-build-inspect-'));
  fs.mkdirSync(path.join(dir, 'CPU0', 'Build'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'CPU1', 'Build'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'qac'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(dir, 'src', 'main.c'), 'void main(void) {}\n');
  fs.writeFileSync(path.join(dir, 'CPU0', '.project'), `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>TCU_CPU0</name>
  <linkedResources>
    <link>
      <name>common_src</name>
      <type>2</type>
      <locationURI>PARENT-1-PROJECT_LOC/src</locationURI>
    </link>
  </linkedResources>
</projectDescription>`);
  fs.writeFileSync(path.join(dir, 'CPU0', '.cproject'), `<?xml version="1.0" encoding="UTF-8"?>
<cproject>
  <storageModule moduleId="org.eclipse.cdt.core.settings">
    <cconfiguration id="v800.cfg.1">
      <storageModule moduleId="cdtBuildSystem" version="4.0.0">
        <configuration name="xxxx-z111-hw_p">
          <folderInfo id="fi.1" resourcePath="">
            <toolChain id="ghs.v800.toolchain">
              <tool id="ghs.v800.cc" command="ccv850">
                <option valueType="includePath" superClass="v800.compiler.include.paths">
                  <listOptionValue value="&quot;\${workspace_loc:/TCU_CPU0/inc}&quot;"/>
                </option>
                <option valueType="definedSymbols" superClass="v800.compiler.symbols">
                  <listOptionValue value="TARGET_Z111=1"/>
                </option>
              </tool>
            </toolChain>
          </folderInfo>
          <sourceEntries>
            <entry flags="VALUE_WORKSPACE_PATH" kind="sourcePath" name="src" excluding="z115/**|unused.c"/>
          </sourceEntries>
        </configuration>
      </storageModule>
    </cconfiguration>
    <cconfiguration id="v800.cfg.2">
      <storageModule moduleId="org.eclipse.cdt.core.settings" configurationName="xxxx-z115-hw_c"/>
    </cconfiguration>
  </storageModule>
</cproject>`);
  fs.writeFileSync(path.join(dir, 'CPU1', '.cproject'), `<?xml version="1.0" encoding="UTF-8"?>
<cproject>
  <storageModule moduleId="org.eclipse.cdt.core.settings" configurationName="xxxx-z111-hw_c"/>
  <storageModule moduleId="org.eclipse.cdt.core.settings" configurationName="xxxx-z115-hw_p"/>
</cproject>`);
  fs.writeFileSync(path.join(dir, 'CPU0', 'Build', 'app.mak'), `
CC = ccv850
CFLAGS = -I../inc -DTARGET_Z111 @flags.rsp
include common.mak
%.o: %.c
\t$(CC) $(CFLAGS) -c $< -o $@
`);
  fs.writeFileSync(path.join(dir, 'qac', 'project.via'), '-i ../inc\n-d TARGET_Z111=1\n');
  fs.writeFileSync(path.join(dir, 'qac', 'map.pl'), '#!/usr/bin/perl\n# map include paths\n');
  return dir;
}

test('scanBuildConfig 与 readBuildConfigFile 识别多核 .cproject、.mak、QAC/.pl 并拦截越权路径', (t) => {
  const dir = makeMultiCoreFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = scanBuildConfig(dir);
  assert.equal(report.ok, true);
  assert.equal(report.multiCoreHint, true);
  assert.equal(report.counts.cprojects, 2);
  assert.equal(report.counts.makefiles, 1);
  assert.equal(report.counts.qacFiles, 1);
  assert.equal(report.counts.perlScripts, 1);

  const cpu0 = report.cprojects.find((c) => c.file === 'CPU0/.cproject');
  assert.ok(cpu0);
  assert.deepEqual(cpu0.configurations.sort(), ['xxxx-z111-hw_p', 'xxxx-z115-hw_c']);
  assert.ok(cpu0.toolchains.includes('v800'));
  assert.ok(cpu0.toolchains.includes('ghs'));
  assert.equal(cpu0.dotProject?.name, 'TCU_CPU0');
  assert.equal(cpu0.dotProject?.linkedResourceCount, 1);
  assert.equal(cpu0.exclusionCount, 1);

  const mk = report.makefiles[0];
  assert.equal(mk.file, 'CPU0/Build/app.mak');
  assert.equal(mk.flags.hasDashI, true);
  assert.equal(mk.flags.hasDashD, true);
  assert.equal(mk.flags.hasResponseFile, true);

  const readRes = readBuildConfigFile(dir, { file: 'CPU0/Build/app.mak', startLine: 1, endLine: 10 });
  assert.equal(readRes.ok, true);
  assert.match(readRes.content, /ccv850/);
  fs.writeFileSync(path.join(dir, 'jp.mak'), Buffer.from([0x93, 0xfa, 0x96, 0x7b]));
  assert.equal(readBuildConfigFile(dir, { file: 'jp.mak', encoding: 'cp932' }).content, '1: 日本');

  const qRes = readBuildConfigFile(dir, { file: 'CPU0/.cproject', query: 'excluding' });
  assert.equal(qRes.ok, true);
  assert.equal(qRes.matches.length, 1);

  const blocked = readBuildConfigFile(dir, { file: '../outside.mak' });
  assert.equal(blocked.ok, false);
});

test('e2e：AI 助手通过 inspect_build_config 只读摸底多核构建配置（不被只读拦截挡住）', async (t) => {
  const dir = makeMultiCoreFixture();
  const toolResults = [];
  let step = 0;
  const mockLlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const last = body.messages?.at(-1);
      if (last?.role === 'tool') toolResults.push(JSON.parse(last.content));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      step++;
      if (step === 1) {
        return res.end(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'inspect_build_config', arguments: JSON.stringify({ action: 'scan' }) } }] } }],
        }));
      }
      if (step === 2) {
        return res.end(JSON.stringify({
          choices: [{ message: { content: '', tool_calls: [{ id: 'b2', type: 'function', function: { name: 'inspect_build_config', arguments: JSON.stringify({ action: 'read', file: 'CPU0/Build/app.mak', startLine: 1, endLine: 20 }) } }] } }],
        }));
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '该工程为多核 v800/GHS 架构，包含 2 个 .cproject 与 .mak。' } }] }));
    });
  });
  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
  const srv = await launchServer({ target: dir });
  t.after(async () => {
    await new Promise((r) => mockLlm.close(r));
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (p, body) => fetch(srv.baseUrl + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  await post('/api/ai/config', { baseUrl: `http://127.0.0.1:${mockLlm.address().port}/v1`, model: 'mock-build', toolMode: 'tools', maxTokens: 4096 });

  // 提问带「为什么/解释」类只读关键词，验证 inspect_build_config 属于只读工具不被拦截
  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '帮我看一下这个项目的构建配置是什么结构，为什么找不到函数' }),
  });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'done'));
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0].multiCoreHint, true);
  assert.equal(toolResults[0].counts.cprojects, 2);
  assert.ok(toolResults[0].parserStatus?.activeParser);
  assert.match(toolResults[1].content, /ccv850/);
});
