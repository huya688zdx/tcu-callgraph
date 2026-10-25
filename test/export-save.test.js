import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { saveExport } = createRequire(import.meta.url)('../electron/export.cjs');

test('导出目录按工程持久记忆，重建保存器后仍可读，取消不更改目录', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-export-'));
  try {
    const a = path.join(temp, '工程甲'), b = path.join(temp, '工程乙'), out = path.join(temp, '导出');
    for (const dir of [a, b, out]) fs.mkdirSync(dir);
    const bytes = new Uint8Array([1, 2, 3]);
    let options;
    const dialog = { showSaveDialog: async (_, opts) => {
      options = opts; return { filePath: path.join(out, '用户改名.html'), canceled: false };
    } };
    await saveExport({ dialog, userData: temp }, { projectPath: a, name: '工程甲_main.html', bytes });
    assert.equal(options.defaultPath, path.join(a, '工程甲_main.html'));
    assert.deepEqual(fs.readFileSync(path.join(out, '用户改名.html')), Buffer.from(bytes));
    const cancel = { showSaveDialog: async (_, opts) => { options = opts; return { canceled: true }; } };
    const saved = () => fs.readFileSync(path.join(temp, 'export-directories.json'), 'utf8');
    const before = saved();
    assert.deepEqual(await saveExport({ dialog: cancel, userData: temp },
      { projectPath: a, name: '工程甲_Task.png', bytes }), { canceled: true });
    assert.equal(options.defaultPath, path.join(out, '工程甲_Task.png'));
    assert.equal(saved(), before);
    await saveExport({ dialog: cancel, userData: temp }, { projectPath: b, name: '工程乙_main.svg', bytes });
    assert.equal(options.defaultPath, path.join(b, '工程乙_main.svg'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
