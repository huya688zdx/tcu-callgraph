import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMakefileTree, discoverBuildProfiles, materializeCompileCommands, selectProfileSourceFiles } from '../src/core/build-config.js';
import { resolveBuildProfileOptions } from '../src/core/build-profile-options.js';
import { loadModel, scanSources } from '../src/core/index.js';
import { builtinParser } from '../src/core/parsers/builtin-parser.js';
import { readCompileCommands } from '../src/core/parsers/clang-parser.js';
import { detectClang, externalDependenciesCurrent } from '../src/core/parsers/clang-config.js';

const cores = ['core0', 'core1'];
const vehicles = ['z111', 'z115'];
const hardware = ['hw_p', 'hw_c'];
const configName = (vehicle, hw) => `tcu-${vehicle}-${hw}`;
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const sorted = (values) => [...values].sort();

function temporaryProject(t) {
  // 父目录也由本测试独占，数据库、导出边界和缓存均可在此隔离。
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-build-config-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  return root;
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function cconfiguration(vehicle, hw) {
  const name = configName(vehicle, hw);
  const excluded = vehicle === 'z111' ? 'z115' : 'z111';
  return `<cconfiguration id="${name}">
    <storageModule moduleId="org.eclipse.cdt.core.settings" configurationName="${name}"/>
    <storageModule moduleId="cdtBuildSystem">
      <configuration id="ghs.${name}">
        <folderInfo resourcePath="">
          <toolChain id="ghs.v800.toolchain">
            <tool command="ccrh850">
              <option valueType="includePath"><listOptionValue value="inc"/></option>
              <option valueType="definedSymbols">
                <listOptionValue value="${hw.toUpperCase()}"/>
                <listOptionValue value="PFTYPE_${vehicle.toUpperCase()}=1"/>
              </option>
            </tool>
          </toolChain>
        </folderInfo>
        <sourceEntries><entry kind="sourcePath" name="src" excluding="${excluded}/**"/></sourceEntries>
      </configuration>
    </storageModule>
  </cconfiguration>`;
}

function projectA(t) {
  const root = temporaryProject(t);
  for (const core of cores) {
    const configs = vehicles.flatMap(vehicle => hardware.map(hw => cconfiguration(vehicle, hw)));
    write(root, `${core}/.cproject`, `<cproject><storageModule>${configs.join('\n')}</storageModule></cproject>`);
    // 扫描头文件只会找到 inc/target，-I inc 必须来自当前构建配置。
    write(root, `${core}/inc/target/types.h`, '/* 项目头文件 */\n');
    write(root, `${core}/src/common.c`, `#include "target/types.h"
#ifdef HW_P
void Build_HwP(void) {}
#else
void Build_HwC(void) {}
#endif
#if PFTYPE_Z111
void Build_Pf111(void) {}
#else
void Build_Pf115(void) {}
#endif
`);
    write(root, `${core}/src/z111/vehicle.c`, 'void Build_Vehicle111(void) {}\n');
    write(root, `${core}/src/z115/vehicle.c`, 'void Build_Vehicle115(void) {}\n');
    write(root, `${core}/src/z115/diagnostics/check.c`, 'void Build_Vehicle115Check(void) {}\n');
    write(root, `build/${core}.mak`, `!include common.mac
CC = ccrh850
CFLAGS = -D$(FAMILY) -I../${core}/inc
SOURCES = ../${core}/src/common.c
`);
  }
  write(root, 'build/common.mac', 'FAMILY = FROM_COMMON_MAC\n');
  write(root, 'qac/analysis.prj', '-i ../core1/inc\n-d QAC_MODE=1\n../core1/src/common.c\n');
  write(root, 'tools/service.c', 'void Build_Tool(void) {}\n');
  return root;
}

function projectB(t) {
  const root = temporaryProject(t);
  write(root, 'build/app.mak', `!include common.mac
!include sources.mak
CC = ccv850
CFLAGS = -I"$(CDIR)/../inc" -D$(PLATFORM) @flags.rsp
all:
\t$(CC) $(CFLAGS) $(SOURCES)
`);
  write(root, 'build/common.mac', 'PLATFORM = LEGACY_V850\n');
  write(root, 'build/sources.mak', 'SOURCES = ../src/start.c ../src/driver.c\n');
  write(root, 'build/flags.rsp', '-I "../rsp inc"\n-D RSP_FEATURE=7\n');
  write(root, 'inc/base.h', '');
  write(root, 'rsp inc/rsp.h', '');
  write(root, 'src/start.c', 'void Start(void) {}\n');
  write(root, 'src/driver.c', 'void Driver(void) {}\n');
  write(root, 'src/unlisted.c', 'void Unlisted(void) {}\n');
  return root;
}

function profileFor(profiles, core, vehicle, hw) {
  const name = configName(vehicle, hw);
  const profile = profiles.find(p => p.configFile === `${core}/.cproject` && p.configName === name);
  assert.ok(profile, `${core} 缺少配置 ${name}`);
  return profile;
}

function expectedFiles(core, vehicle) {
  const files = [`${core}/src/common.c`, `${core}/src/${vehicle}/vehicle.c`];
  if (vehicle === 'z115') files.push(`${core}/src/z115/diagnostics/check.c`);
  return sorted(files);
}

function expectedVehicleFunctions(vehicle) {
  return vehicle === 'z111' ? ['Build_Vehicle111'] : ['Build_Vehicle115', 'Build_Vehicle115Check'];
}

function profileOptions(root, core, vehicle, hw) {
  const profile = profileFor(discoverBuildProfiles(root).profiles, core, vehicle, hw);
  return {
    buildProfileId: profile.id,
    activeFiles: selectProfileSourceFiles(profile, scanSources(root)),
    defines: profile.defines,
  };
}

test('工程 A 发现两个核的八套 CDT 配置，并区分 Make 和 QAC 配置', t => {
  const root = projectA(t);
  const report = discoverBuildProfiles(root);
  assert.equal(report.ok, true);
  assert.equal(report.multiCoreHint, true);
  const eclipse = report.profiles.filter(p => p.source === 'cproject');
  assert.equal(eclipse.length, 8);
  assert.equal(new Set(eclipse.map(p => p.id)).size, 8);
  for (const core of cores) {
    for (const vehicle of vehicles) {
      for (const hw of hardware) {
        const p = profileFor(eclipse, core, vehicle, hw);
        assert.equal(p.arch, 'rh850', p.id);
        assert.match(p.compiler, /ghs/i);
        assert.deepEqual(p.includeDirs, [path.join(root, core, 'inc')], p.id);
        assert.deepEqual(sorted(p.defines), sorted([hw.toUpperCase(), `PFTYPE_${vehicle.toUpperCase()}=1`]), p.id);
      }
    }
    const make = report.profiles.find(p => p.source === 'makefile' && p.configFile === `build/${core}.mak`);
    assert.ok(make);
    assert.ok(make.defines.includes('FROM_COMMON_MAC'));
    assert.deepEqual(make.sourceFiles, [`${core}/src/common.c`]);
  }
  const qac = report.profiles.find(p => p.source === 'qac' && p.configFile === 'qac/analysis.prj');
  assert.ok(qac);
  assert.deepEqual(qac.includeDirs, [path.join(root, 'core1/inc')]);
  assert.deepEqual(qac.defines, ['QAC_MODE=1']);
  assert.deepEqual(qac.sourceFiles, ['core1/src/common.c']);
  assert.equal(report.cprojectCount, 2);
});

test('工程 A 每套配置只选择本核、当前车型的源文件，包含嵌套目录', t => {
  const root = projectA(t);
  const scan = scanSources(root);
  const { profiles } = discoverBuildProfiles(root);
  for (const core of cores) {
    for (const vehicle of vehicles) {
      for (const hw of hardware) {
        const profile = profileFor(profiles, core, vehicle, hw);
        assert.deepEqual(sorted(selectProfileSourceFiles(profile, scan)), expectedFiles(core, vehicle), profile.id);
      }
    }
  }
});

function materialize(root, core, vehicle, hw) {
  const profile = profileFor(discoverBuildProfiles(root).profiles, core, vehicle, hw);
  return materializeCompileCommands(root, profile, {
    files: scanSources(root), cacheDir: path.join(path.dirname(root), 'cache'),
  });
}

function checkRh850Flags(args, directory, shimPath, coreInc, defines) {
  const values = flag => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
  assert.deepEqual(sorted(values('-D')), sorted(defines));
  assert.ok(values('-include').some(file => path.resolve(directory, file) === shimPath));
  assert.ok(values('-I').some(dir => path.resolve(directory, dir) === coreInc));
}

test('工程 A 生成可读的编译数据库及 RH850 兼容头，逐单元保留编译选项', t => {
  const root = projectA(t);
  const mat = materialize(root, 'core1', 'z115', 'hw_c');
  assert.equal(path.basename(mat.compileCommandsPath), 'compile_commands.json');
  assert.equal(path.basename(mat.shimPath), 'compat_rh850.h');
  const shim = fs.readFileSync(mat.shimPath, 'utf8');
  for (const name of ['__ghs__', '__V800__', '__RH850__', '__interrupt', '_interrupt', '_attribute']) {
    assert.match(shim, new RegExp(`^\\s*#\\s*define\\s+${name}\\b`, 'm'));
  }
  const entries = JSON.parse(fs.readFileSync(mat.compileCommandsPath, 'utf8'));
  const expected = expectedFiles('core1', 'z115');
  assert.equal(mat.unitCount, expected.length);
  const files = entries.map(({ file, arguments: args, directory }) => {
    assert.ok(path.isAbsolute(directory) && fs.statSync(directory).isDirectory());
    assert.ok(Array.isArray(args) && args.length > 1);
    const source = path.resolve(directory, file);
    assert.ok(args.slice(1).some(arg => path.resolve(directory, arg) === source));
    checkRh850Flags(args, directory, mat.shimPath, path.join(root, 'core1/inc'), ['HW_C', 'PFTYPE_Z115=1']);
    return relative(root, source);
  });
  assert.deepEqual(sorted(files), expected);
});

test('工程 B 从纯 Make 的变量、子 Makefile 和响应文件恢复 V850 编译配置', t => {
  const root = projectB(t);
  const report = discoverBuildProfiles(root);
  assert.equal(report.multiCoreHint, false);
  assert.ok(report.profiles.every(p => p.source === 'makefile'));
  const make = report.profiles.find(p => p.configFile === 'build/app.mak');
  assert.ok(make);
  assert.equal(make.arch, 'v850');
  assert.match(make.compiler, /ccv850/i);
  assert.deepEqual(sorted(make.includeDirs), sorted([path.join(root, 'inc'), path.join(root, 'rsp inc')]));
  assert.deepEqual(sorted(make.defines), ['LEGACY_V850', 'RSP_FEATURE=7']);
  assert.deepEqual(sorted(make.sourceFiles), ['src/driver.c', 'src/start.c']);
  assert.deepEqual(sorted(selectProfileSourceFiles(make, scanSources(root))), ['src/driver.c', 'src/start.c']);
  assert.equal(report.cprojectCount, 0);
});

test('导出前检查兼容头和数据库的目标类型', t => {
  const root = temporaryProject(t);
  const profile = { id: 'test', arch: 'rh850' };
  const shim = path.join(root, '.tcu-callgraph-compat', 'compat_rh850.h');
  const database = write(root, 'compile_commands.json', '[]');
  fs.mkdirSync(shim, { recursive: true });
  const generate = () => materializeCompileCommands(root, profile, { exportPath: 'compile_commands.json' });
  assert.throws(generate, /普通文件/);
  assert.equal(fs.readFileSync(database, 'utf8'), '[]');
  fs.rmdirSync(shim);
  fs.unlinkSync(database);
  fs.mkdirSync(database);
  assert.throws(generate, /普通文件/);
  assert.equal(fs.existsSync(shim), false);
  fs.rmdirSync(database);
  // 模拟系统报告兼容头目录解析到工程外；测试只在本用例的工程目录内读写。
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', file => file === path.dirname(shim) ? path.dirname(root) : realpath(file));
  assert.throws(generate, /超出工程目录/);
  assert.equal(fs.existsSync(shim), false);
  assert.equal(fs.existsSync(database), false);
});

test('编译数据库从编译工作目录展开独立的 @flags.rsp，保留带空格的路径', t => {
  const root = projectB(t);
  const directory = path.join(root, 'build');
  const entry = { directory, file: '../src/start.c', arguments: ['ccv850', '@flags.rsp', '-c', '../src/start.c'] };
  const database = write(root, 'compile_commands.json', JSON.stringify([entry]));
  const [unit] = readCompileCommands(root, database, { files: scanSources(root) });
  assert.equal(unit.rel, 'src/start.c');
  assert.deepEqual(unit.args, ['-I', path.join(root, 'rsp inc'), '-D', 'RSP_FEATURE=7']);
});

test('编译数据库拒绝 -I @bad，包括同名响应文件存在的情况', t => {
  const root = projectB(t);
  const entry = { directory: path.join(root, 'build'), file: '../src/start.c', arguments: ['ccv850', '-I', '@bad'] };
  const database = write(root, 'compile_commands.json', JSON.stringify([entry]));
  const read = () => readCompileCommands(root, database, { files: scanSources(root) });
  assert.throws(read, /-I/);
  write(root, 'build/bad', '../inc\n');
  assert.throws(read, /-I/, '选项的操作数不能当作独立的响应文件展开');
});

test('Clang 模型缓存检查嵌套响应文件内容、删除和新增的响应文件', async t => {
  const root = temporaryProject(t);
  write(root, 'main.c', 'void main_fn(void) {}');
  write(root, 'args.rsp', '@flags.rsp @optional.rsp');
  const flags = write(root, 'flags.rsp', '-DMODE=1');
  const database = write(root, 'compile_commands.json', JSON.stringify([{
    directory: root, file: 'main.c', arguments: ['clang', '@args.rsp', 'main.c'],
  }]));
  const model = await loadModel(root, { parserId: 'clang-ast', parserOptions: {
    compileCommandsPath: database, execClang: () => ({ kind: 'TranslationUnitDecl', inner: [] }),
  } });
  assert.equal(externalDependenciesCurrent(model), true);
  fs.writeFileSync(flags, '-DMODE=0');
  assert.equal(externalDependenciesCurrent(model), false);
  fs.unlinkSync(flags);
  assert.equal(externalDependenciesCurrent(model), false);
  fs.writeFileSync(flags, '-DMODE=1');
  assert.equal(externalDependenciesCurrent(model), true);
  write(root, 'optional.rsp', '-DNEW');
  assert.equal(externalDependenciesCurrent(model), false);
});

test('builtin 按构建配置过滤车型函数，并遵守空的编译单元清单', t => {
  const root = projectA(t);
  for (const vehicle of vehicles) {
    const parserOptions = profileOptions(root, 'core0', vehicle, 'hw_p');
    const model = loadModel(root, { parserId: 'builtin', parserOptions });
    const functions = model.functions.filter(f => f.name.startsWith('Build_Vehicle'));
    assert.deepEqual(sorted(functions.map(f => f.name)), expectedVehicleFunctions(vehicle));
    assert.deepEqual(sorted(model.files.filter(f => !f.isHeader).map(f => f.rel)), expectedFiles('core0', vehicle));
  }
  const options = profileOptions(root, 'core0', 'z111', 'hw_p');
  const empty = loadModel(root, { parserId: 'builtin', parserOptions: { ...options, activeFiles: [] } });
  assert.deepEqual(empty.functions.map(f => f.name), [], '空的构建配置不应解析任何 .c 函数');
});

test('builtin 使用构建配置的标志宏决定 #ifdef 与 #else', t => {
  const root = projectA(t);
  for (const [hw, expected] of [['hw_p', 'Build_HwP'], ['hw_c', 'Build_HwC']]) {
    const parserOptions = profileOptions(root, 'core0', 'z111', hw);
    const model = loadModel(root, { parserId: 'builtin', parserOptions });
    assert.deepEqual(model.functions.map(f => f.name).filter(n => n.startsWith('Build_Hw')), [expected], hw);
  }
});

test('builtin 按 -D 的数值求 #if，能区分同一个宏的 1 和 0', t => {
  const root = projectA(t);
  const options = profileOptions(root, 'core0', 'z111', 'hw_p');
  for (const [defines, expected] of [[options.defines, 'Build_Pf111'], [['HW_P', 'PFTYPE_Z111=0'], 'Build_Pf115']]) {
    const model = loadModel(root, { parserId: 'builtin', parserOptions: { ...options, defines } });
    assert.deepEqual(model.functions.map(f => f.name).filter(n => n.startsWith('Build_Pf')), [expected], defines.join(' '));
  }
});

test('builtin 的缓存键分别区分配置标识、活动文件与宏值', t => {
  const root = projectA(t);
  const options = profileOptions(root, 'core0', 'z111', 'hw_p');
  const key = opts => builtinParser.cacheKey(root, opts);
  for (const base of [options, { activeFiles: options.activeFiles, defines: options.defines }]) {
    assert.equal(key(base), key({ ...base }));
    assert.notEqual(key(base), key({ ...base, buildProfileId: 'second-profile' }), '配置标识');
    assert.notEqual(key(base), key({ ...base, activeFiles: ['core0/src/common.c'] }), '活动文件');
    assert.notEqual(key(base), key({ ...base, defines: ['HW_P', 'PFTYPE_Z111=0'] }), '宏值');
  }
});

test('Clang 严格模式只调用数据库列出的 TU，并向每次调用传递该配置的参数', async t => {
  const root = projectA(t);
  const mat = materialize(root, 'core0', 'z111', 'hw_p');
  const compiled = [];
  await loadModel(root, { parserId: 'clang-ast', parserOptions: {
    compileCommandsPath: mat.compileCommandsPath,
    strictCompileCommands: true,
    execClang(file, args, { cwd }) {
      compiled.push({ file, args, cwd });
      return { kind: 'TranslationUnitDecl', inner: [] };
    },
  } });
  assert.deepEqual(sorted(compiled.map(({ file }) => relative(root, file))), expectedFiles('core0', 'z111'));
  for (const { file, args, cwd } of compiled) {
    assert.equal(args.at(-1), file);
    checkRh850Flags(args, cwd, mat.shimPath, path.join(root, 'core0/inc'), ['HW_P', 'PFTYPE_Z111=1']);
  }
});

async function startServer(root) {
  const sandbox = path.dirname(root);
  // 服务进程会在系统临时目录生成兼容头。与 SQLite 库一起放入本用例的目录。
  const child = fork(fileURLToPath(new URL('../src/server.js', import.meta.url)), [root, '0'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CALLGRAPH_DB: path.join(sandbox, 'test.db'),
      CALLGRAPH_CLANG: path.join(sandbox, 'missing-clang'), TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const closed = once(child, 'close');
  const close = async () => {
    child.kill();
    await closed;
  };
  try {
    const [{ port }] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15000) }),
      closed.then(() => { throw new Error('服务在就绪前退出'); }),
    ]);
    const request = async (route, body, status = 200) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, `${route} ${JSON.stringify(result)}`);
      return result;
    };
    return { request, close };
  } catch (error) {
    await close();
    throw new Error(`测试服务启动失败\n${logs}`, { cause: error });
  }
}

test('构建配置 API 在同一服务中列举、切换并导出车型', async t => {
  const root = projectA(t);
  const { request, close } = await startServer(root);
  const route = '/api/build-configs';
  try {
    const listed = await request(route);
    await t.test('列出双核配置、源码总数和 Clang 探测结果', () => {
      assert.equal(listed.ok, true);
      assert.equal(listed.multiCoreHint, true);
      assert.equal(listed.totalSourceFiles, 9);
      assert.equal(listed.clangStatus.ok, false);
      assert.match(listed.clangStatus.reason, /ENOENT/);
      assert.deepEqual(sorted(listed.profiles.filter(p => p.source === 'makefile').map(p => p.configFile)),
        ['build/core0.mak', 'build/core1.mak']);
      assert.ok(listed.profiles.some(p => p.source === 'qac' && p.configFile === 'qac/analysis.prj'));
      assert.equal(listed.profiles.filter(p => p.source === 'cproject').length, 8);
      assert.equal(listed.cprojectCount, 2);
    });

    const localProfiles = discoverBuildProfiles(root).profiles;
    const switches = [['首次选择', 'z111', 'hw_p'], ['切换', 'z115', 'hw_c'], ['切回', 'z111', 'hw_p']];
    for (const [action, vehicle, hw] of switches) {
      const { id } = profileFor(localProfiles, 'core0', vehicle, hw);
      const selected = await request(route, { profileId: id, parserId: 'builtin' });
      assert.equal(selected.activeProfileId, id);
      assert.equal(selected.activeParser, 'builtin');
      assert.equal((await request(route)).activeProfileId, id);
      const expected = sorted([...expectedVehicleFunctions(vehicle),
        vehicle === 'z111' ? 'Build_Pf111' : 'Build_Pf115', hw === 'hw_p' ? 'Build_HwP' : 'Build_HwC']);
      await t.test(`${action} ${vehicle}/${hw} 后 stats 只统计当前源文件和函数`, async () => {
        const result = await request('/api/stats');
        assert.deepEqual(sorted(result.files.filter(f => !f.isHeader).map(f => f.rel)), expectedFiles('core0', vehicle));
        assert.equal(result.stats.functions, expected.length);
      });
      await t.test(`${action} ${vehicle}/${hw} 后 search 返回当前车型及活动分支的函数`, async () => {
        const result = await request('/api/search?q=Build_');
        assert.deepEqual(sorted(result.map(f => f.name)), expected);
        assert.ok(result.every(f => f.file.startsWith('core0/src/')));
      });
    }

    const { id } = profileFor(localProfiles, 'core1', 'z115', 'hw_c');
    await t.test('按指定配置将数据库写入工程根目录', async () => {
      const database = path.join(root, 'compile_commands.json');
      assert.equal(fs.existsSync(database), false);
      const result = await request(route, { profileId: id, exportCompileCommands: true });
      assert.equal(result.ok, true);
      assert.equal(result.exportedPath, database);
      const entries = JSON.parse(fs.readFileSync(database, 'utf8'));
      const files = entries.map(e => relative(root, path.resolve(e.directory, e.file)));
      const expected = expectedFiles('core1', 'z115');
      assert.equal(result.unitCount, expected.length);
      assert.deepEqual(sorted(files), expected);
    });
    await t.test('拒绝父目录导出路径并返回 HTTP 400', async () => {
      // 用已存在的目录作目标，即使校验退化也无法写入文件。
      const reserved = path.join(path.dirname(root), 'reserved.json');
      fs.mkdirSync(reserved);
      const result = await request(route, { profileId: id, exportCompileCommands: true, exportPath: '../reserved.json' }, 400);
      assert.equal(result.ok, false);
      assert.match(result.error, /工程目录/);
      assert.deepEqual(fs.readdirSync(reserved), []);
    });
  } finally {
    await close();
  }
});

test('Make 只采集活动分支并保留宏参数顺序', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-conditions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'active.c'), 'int active;');
  fs.writeFileSync(path.join(root, 'unused.c'), 'int unused;');
  fs.writeFileSync(path.join(root, 'bad.mk'), 'CFLAGS = -DBAD');
  fs.writeFileSync(path.join(root, 'Makefile'), `MODE = release
ifeq ($(MODE),debug)
include bad.mk
CFLAGS = -DDEBUG
all: unused.c
\tcc $(CFLAGS) unused.c
else ifneq ($(MODE),release)
CFLAGS = -DWRONG
else
ifdef MODE
CFLAGS = -DFEATURE=1 -UFEATURE -DOTHER=1 -UOTHER -DOTHER=2
endif
all: active.c
\tcc $(CFLAGS) active.c
endif
`);
  const result = parseMakefileTree(path.join(root, 'Makefile'), root);
  assert.deepEqual(result.sourceFiles, ['active.c']);
  assert.deepEqual(result.defines, ['OTHER=2']);
  assert.deepEqual(result.includedFiles, ['Makefile']);
  const profile = discoverBuildProfiles(root).profiles.find(p => p.source === 'makefile');
  assert.deepEqual(profile.defines, ['OTHER=2']);
  const generated = materializeCompileCommands(root, profile, { files: scanSources(root), exportPath: 'compile_commands.json' });
  const args = JSON.parse(fs.readFileSync(generated.compileCommandsPath, 'utf8'))[0].arguments;
  assert.deepEqual(args.slice(args.indexOf('-D'), -1), result.macroArgs);

  assert.deepEqual(result.macroArgs, ['-D', 'FEATURE=1', '-U', 'FEATURE', '-D', 'OTHER=1', '-U', 'OTHER', '-D', 'OTHER=2']);
});

test('坏 Makefile 不影响其他配置，保留快照独有的源文件', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bad.mak'), '!IF 1\nCFLAGS=-DBAD\n!ENDIF');
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\tcc keep.c deleted.c');
  fs.writeFileSync(path.join(root, 'keep.c'), 'int keep;');
  const profiles = discoverBuildProfiles(root).profiles;
  assert.equal(profiles.length, 1);
  assert.deepEqual(profiles[0].sourceFiles, ['keep.c', 'deleted.c']);
  assert.deepEqual(selectProfileSourceFiles(profiles[0], [{ rel: 'keep.c' }, { rel: 'deleted.c' }]), ['keep.c', 'deleted.c']);
});

test('Make 目标变量传递给依赖且不污染其他目标', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-target-vars-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['main', 'other']) fs.writeFileSync(path.join(root, name + '.c'), 'int value;');
  fs.writeFileSync(path.join(root, 'Makefile'), [
    'CFLAGS = -DGLOBAL=1', 'all: main.o other.o',
    'main.o: CFLAGS = -DFEATURE=1', 'main.o: EXTRA = -DEXTRA=1',
    'main.o: child', 'child: CFLAGS += $(EXTRA)',
    'child: main.c', '\tcc $(CFLAGS) -c main.c',
    'other.o: other.c', '\tcc $(CFLAGS) -c other.c',
  ].join('\n'));
  const result = parseMakefileTree(path.join(root, 'Makefile'), root);
  assert.deepEqual(result.compilationUnits['main.c'].defines, ['FEATURE=1', 'EXTRA=1']);
  assert.deepEqual(result.compilationUnits['other.c'].defines, ['GLOBAL=1']);
});

test('GNU Make 嵌套 include 使用构建目录', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-cwd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'main.c'), 'int value;');
  fs.writeFileSync(path.join(root, 'common.mk'), 'CFLAGS = -DFEATURE=1');
  fs.writeFileSync(path.join(root, 'build/common.mk'), 'CFLAGS = -DFEATURE=0');
  fs.writeFileSync(path.join(root, 'build/flags.mk'), 'include common.mk');
  fs.writeFileSync(path.join(root, 'Makefile'), 'include build/flags.mk\nall: main.c\n\tcc $(CFLAGS) -c main.c'.replaceAll('\\n', '\n').replaceAll('\\t', '\t'));
  const result = parseMakefileTree(path.join(root, 'Makefile'), root);
  assert.deepEqual(result.defines, ['FEATURE=1']);
  assert.deepEqual(result.includedFiles, ['Makefile', 'build/flags.mk', 'common.mk']);
});

test('构建配置保留每个编译单元的头文件搜索顺序和 C 标准', async t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', [
    'all:',
    '\tcc -std=c11 @angle.rsp -c angle.c',
    '\tcc -std=gnu11 -iquote private -Ipublic -c quote.c',
  ].join('\n'));
  write(root, 'angle.rsp', '-idirafter after -isystemsystem -iquote "private" -Ipublic -std=c99');
  for (const [dir, feature] of [['private', 1], ['public', 2], ['system', 3], ['after', 4]]) {
    write(root, dir + '/config.h', '#define FEATURE ' + feature);
  }
  for (const [name, include, feature, standard] of [
    ['angle', '<config.h>', 2, '199901L'],
    ['quote', '"config.h"', 1, '201112L'],
  ]) {
    write(root, name + '.c', [
      '#include ' + include,
      '#if FEATURE == ' + feature + ' && __STDC__ == 1 && __STDC_VERSION__ == ' + standard,
      'void ' + name + '_correct(void) {}',
      '#else',
      'void ' + name + '_wrong(void) {}',
      '#endif',
    ].join('\n'));
  }
  const profile = discoverBuildProfiles(root).profiles[0];
  const files = scanSources(root);
  const options = { buildProfileId: profile.id };
  const builtin = loadModel(root, { parserId: 'builtin',
    parserOptions: resolveBuildProfileOptions(root, 'builtin', options, files, profile) });
  const expected = ['angle_correct', 'quote_correct'];
  assert.deepEqual(sorted(builtin.functions.map(f => f.name)), expected);

  const { compileCommandsPath } = materializeCompileCommands(root, profile, { files, exportPath: 'compile_commands.json' });
  const units = new Map(readCompileCommands(root, compileCommandsPath).map(unit => [unit.rel, unit.args]));
  for (const [flag, dir] of [['-idirafter', 'after'], ['-isystem', 'system'], ['-iquote', 'private'], ['-I', 'public']]) {
    const args = units.get('angle.c');
    assert.equal(args[args.indexOf(flag) + 1], path.join(root, dir));
  }
  assert.ok(units.get('angle.c').includes('-std=c99'));
  assert.ok(units.get('quote.c').includes('-std=gnu11'));
  if (detectClang().ok) {
    const clang = await loadModel(root, { parserId: 'clang-ast',
      parserOptions: { compileCommandsPath, strictCompileCommands: true } });
    assert.deepEqual(sorted(clang.functions.map(f => f.name)), expected);
  }
});

test('Make 在每个 include 位置重新计算变量并按名称处理函数式宏的重定义', async t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', [
    'MODE = 1', 'include flags.mk', 'MODE = 2', 'include flags.mk',
    'all:', "\tcc $(CFLAGS) '-DREMOVED(x)=x' -UREMOVED '-DENABLED(x)=0' -UENABLED '-DENABLED(x)=x' -U__STDC__ -c main.c",
  ].join('\n'));
  write(root, 'flags.mk', 'CFLAGS := -DMODE=$(MODE)\n');
  write(root, 'main.c', [
    '#if MODE == 2 && !defined(__STDC__) && !defined(REMOVED) && ENABLED(1)',
    'void correct(void) {}', '#else', 'void wrong(void) {}', '#endif',
  ].join('\n'));
  const profile = discoverBuildProfiles(root).profiles.find(p => p.configFile === 'Makefile');
  const files = scanSources(root);
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile);
  assert.deepEqual(profile.compilationUnits['main.c'].defines, ['MODE=2', 'ENABLED(x)=x']);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: options });
  assert.deepEqual(model.functions.map(fn => fn.name), ['correct']);
  const { compileCommandsPath } = materializeCompileCommands(root, profile, { files, exportPath: 'compile_commands.json' });
  const [{ args }] = readCompileCommands(root, compileCommandsPath);
  assert.deepEqual(args.slice(args.indexOf('-D')), [
    '-D', 'MODE=2', '-D', 'REMOVED(x)=x', '-U', 'REMOVED', '-D', 'ENABLED(x)=0', '-U', 'ENABLED', '-D', 'ENABLED(x)=x',
    '-U', '__STDC__',
  ]);
  if (detectClang().ok) {
    const clang = await loadModel(root, { parserId: 'clang-ast',
      parserOptions: { compileCommandsPath, strictCompileCommands: true } });
    assert.deepEqual(clang.functions.map(fn => fn.name), ['correct']);
  }
});

test('流程图接口读取构建配置选中的外部 SDK 头与嵌套头', async t => {
  const root = temporaryProject(t);
  const sdk = path.join(path.dirname(root), 'sdk');
  write(sdk, 'config.h', '#include "nested.h"\n');
  write(sdk, 'nested.h', '#define RUN() selected()\n');
  write(root, 'config.h', '#define RUN() wrong()\n');
  write(root, 'Makefile', 'all:\n\tcc -I../sdk -c main.c\n');
  write(root, 'main.c', [
    '#include <config.h>', 'static void selected(void) {}', 'void run(void) { RUN(); }',
  ].join('\n'));
  const { request, close } = await startServer(root);
  t.after(close);
  await request('/api/build-configs', { profileId: 'make::Makefile' });
  for (const expandMacros of [0, 1]) {
    const query = new URLSearchParams({ id: 'main.c::run', expandMacros });
    const result = await request('/api/flowchart?' + query);
    assert.ok(result.ok);
    assert.ok(result.macrosUsed.some(macro => macro.name === 'RUN' && macro.file === '../sdk/nested.h'));
    assert.ok(result.nodes.some(node => node.callees?.some(callee => callee.name === 'selected')));
  }
});

test('构建配置在强制包含前处理 -imacros，且丢弃宏文件子树的声明', async t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', 'all:\n\tcc -include startup.h -I flags -imacros options.h -c main.c\n');
  write(root, 'flags/options.h', '#include "nested.h"\nstatic void ignored(void) {}\n');
  write(root, 'flags/nested.h', '#define FEATURE 1\nstatic void also_ignored(void) {}\n');
  write(root, 'startup.h', '#if FEATURE\n#define ACTIVE 1\n#endif\nstatic void startup(void) {}\n');
  write(root, 'main.c', '#if ACTIVE\nvoid correct(void) {}\n#else\nvoid wrong(void) {}\n#endif\n');
  const profile = discoverBuildProfiles(root).profiles[0];
  const files = scanSources(root);
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile);
  const builtin = loadModel(root, { parserId: 'builtin', parserOptions: options });
  assert.deepEqual(sorted(builtin.functions.map(fn => fn.name)), ['correct', 'startup']);
  const { compileCommandsPath } = materializeCompileCommands(root, profile, { files, exportPath: 'compile_commands.json' });
  const [{ args }] = readCompileCommands(root, compileCommandsPath);
  assert.deepEqual(args.slice(args.indexOf('-imacros')), ['-imacros', 'options.h', '-include', path.join(root, 'startup.h')]);
  if (detectClang().ok) {
    const clang = await loadModel(root, { parserId: 'clang-ast',
      parserOptions: { compileCommandsPath, strictCompileCommands: true } });
    assert.deepEqual(sorted(clang.functions.map(fn => fn.name)), ['correct', 'startup']);
  }
});

test('Make 自动变量合并同一目标的多个规则，保持配方依赖优先并排除顺序依赖', t => {
  const root = temporaryProject(t);
  const makefile = write(root, 'Makefile', [
    'all: main.o other.o',
    'main.o: main.c | order.c',
    'main.o:',
    '\tcc -DMAIN -c $<',
    'other.o: before.c shared.c',
    'other.o: other.c shared.c',
    '\tcc -DFIRST=$< -DUNIQUE="$^" -DALL="$+" -c $<',
    'other.o: last.c',
  ].join('\n'));
  for (const file of ['main', 'order', 'before', 'shared', 'other', 'last']) write(root, file + '.c', 'int value;');
  const profile = parseMakefileTree(makefile, root);
  assert.deepEqual(profile.sourceFiles, ['main.c', 'other.c']);
  assert.deepEqual(profile.compilationUnits['main.c'].defines, ['MAIN']);
  assert.deepEqual(profile.compilationUnits['other.c'].defines, [
    'FIRST=other.c', 'UNIQUE=other.c shared.c before.c last.c', 'ALL=other.c shared.c before.c shared.c last.c',
  ]);
});

test('流程图按编译单元展开构建宏，并绑定 .inc 中可见的静态函数', async t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', [
    'all:', '\tcc -DSELECTED=helper -c a.c', '\tcc -DRUN=other -c b.c',
  ].join('\n'));
  write(root, 'helper.inc', '#if MODE\n#define RUN SELECTED\n#endif\nstatic inline void helper(void) {}\n');
  write(root, 'a.c', '#define MODE 1\n#include "helper.inc"\n#undef MODE\nvoid runA(void) { RUN(); }\n');
  write(root, 'b.c', 'static void other(void) {}\nvoid runB(void) { RUN(); }\n');
  const { request, close } = await startServer(root);
  t.after(close);
  await request('/api/build-configs', { profileId: 'make::Makefile' });
  for (const [id, calleeId, name, macroFile] of [
    ['a.c::runA', 'helper.inc::helper', 'helper', 'helper.inc'],
    ['b.c::runB', 'b.c::other', 'other', '<build-config>'],
  ]) {
    const query = new URLSearchParams({ id, expandMacros: 1 });
    const result = await request('/api/flowchart?' + query);
    const invocation = result.nodes.find(node => node.kind === 'call');
    assert.match(invocation.text, new RegExp(name + '\\(\\)'));
    assert.ok(invocation.callees.some(callee => callee.id === calleeId));
    assert.ok(result.macrosUsed.some(macro => macro.name === 'RUN' && macro.file === macroFile));
  }
});

test('构建配置从找到包装头的目录之后解析 include_next', async t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', 'all:\n\tcc -Iwrap -Isdk -c main.c');
  write(root, 'wrap/pkg/config.h', '#pragma once\n#include_next <pkg/config.h>\n');
  write(root, 'sdk/pkg/config.h', '#define FEATURE 1\n');
  write(root, 'main.c', [
    '#include <pkg/config.h>', '#if FEATURE',
    'void wrapped(void) {}', '#else', 'void wrong(void) {}', '#endif',
  ].join('\n'));
  const profile = discoverBuildProfiles(root).profiles[0];
  const files = scanSources(root);
  const options = { buildProfileId: profile.id };
  const builtin = loadModel(root, { parserId: 'builtin',
    parserOptions: resolveBuildProfileOptions(root, 'builtin', options, files, profile) });
  assert.deepEqual(builtin.functions.map(fn => fn.name), ['wrapped']);
  assert.ok(builtin.includes.some(inc => inc.file === 'wrap/pkg/config.h' && inc.resolved === 'sdk/pkg/config.h'));
  if (detectClang().ok) {
    const clang = await loadModel(root, { parserId: 'clang-ast',
      parserOptions: resolveBuildProfileOptions(root, 'clang-ast', options, files, profile, path.dirname(root)) });
    assert.deepEqual(clang.functions.map(fn => fn.name), ['wrapped']);
  }
});

test('include_next 跳过与本地包装头目录重复的 -I 路径', t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', 'all:\n\tcc -I. -Isdk -c main.c');
  write(root, 'config.h', '#pragma once\n#include_next <config.h>\n');
  write(root, 'sdk/config.h', '#define FEATURE 1\n');
  write(root, 'main.c', [
    '#include "config.h"', '#if FEATURE',
    'void wrapped(void) {}', '#else', 'void wrong(void) {}', '#endif',
  ].join('\n'));
  const profile = discoverBuildProfiles(root).profiles[0];
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, scanSources(root), profile);
  const model = loadModel(root, { parserId: 'builtin', parserOptions: options });
  assert.deepEqual(model.functions.map(fn => fn.name), ['wrapped']);
});

test('Make 引号条件保留空操作数并选择正确的编译参数', t => {
  const root = temporaryProject(t);
  const file = write(root, 'Makefile', [
    'MODE =', 'ifeq "$(MODE)" ""', 'CFLAGS = -DEMPTY', 'else', 'CFLAGS = -DWRONG', 'endif',
    "ifneq 'on' ''", 'CFLAGS += -DENABLED', 'endif', 'all:', '\tcc $(CFLAGS) -c main.c',
  ].join('\n'));
  write(root, 'main.c', 'int value;');
  assert.deepEqual(parseMakefileTree(file, root).compilationUnits['main.c'].defines, ['EMPTY', 'ENABLED']);
});

test('Make 复合配方的每个编译调用独立收集参数，引号中的分号保持为数据', t => {
  const root = temporaryProject(t);
  write(root, 'Makefile', [
    'CC = vendor-cc-custom', 'all:',
    '\t$(CC) -DFEATURE=1 -DMESSAGE="a;b" -c first.c; $(CC) -DFEATURE=0 -c second.c && echo -DIGNORED',
  ].join('\n'));
  for (const [rel, mode] of [['first', 1], ['second', 0]]) {
    write(root, rel + '.c', '#if FEATURE == ' + mode + '\nvoid ' + rel + '_correct(void) {}\n#endif');
  }
  const profile = discoverBuildProfiles(root).profiles[0];
  assert.deepEqual(profile.compilationUnits['first.c'].defines, ['FEATURE=1', 'MESSAGE=a;b']);
  assert.deepEqual(profile.compilationUnits['second.c'].defines, ['FEATURE=0']);
  const files = scanSources(root);
  const options = resolveBuildProfileOptions(root, 'builtin', { buildProfileId: profile.id }, files, profile);
  assert.deepEqual(sorted(loadModel(root, { parserId: 'builtin', parserOptions: options }).functions.map(fn => fn.name)),
    ['first_correct', 'second_correct']);
});
