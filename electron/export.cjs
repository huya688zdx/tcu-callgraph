/** 原生导出：保存成功后按工程记住目录，取消时不修改记录。 */
const fs = require('node:fs');
const path = require('node:path');

async function saveExport({ dialog, window, userData }, { name, bytes, projectPath }) {
  const extension = path.extname(name || '').slice(1).toLowerCase();
  if (!['html', 'png', 'svg'].includes(extension) || path.basename(name) !== name ||
      typeof projectPath !== 'string' || !projectPath || !(bytes instanceof Uint8Array)) {
    throw new Error('无效的导出文件');
  }
  const settingsFile = path.join(userData, 'export-directories.json');
  const readDirectories = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
  };
  const key = process.platform === 'win32' ? path.resolve(projectPath).toLowerCase() : path.resolve(projectPath);
  let directory = readDirectories()[key] || projectPath;
  try {
    if (!fs.statSync(directory).isDirectory()) directory = path.dirname(directory);
  } catch { directory = path.dirname(projectPath); }
  const result = await dialog.showSaveDialog(window, {
    title: '导出 ' + extension.toUpperCase(),
    defaultPath: path.join(directory, name),
    filters: [{ name: extension.toUpperCase() + ' 文件', extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, bytes);
  const directories = readDirectories();
  directories[key] = path.dirname(result.filePath);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(directories), 'utf8');
  return { canceled: false };
}

module.exports = { saveExport };
