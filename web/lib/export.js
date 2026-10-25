/** GUI 与离线 HTML 共用的文件命名、保存和 PNG 底色。 */
import { state, els } from './state.js';
import { api } from './api.js';

export function exportName(extension, project) {
  const view = state.view;
  const roots = view.roots?.length ? view.roots : [view.root];
  const root = view.nodes.find((n) => n.id === roots[0]);
  const label = (root?.name || '调用关系') + (roots.length > 1 ? `等${roots.length}个入口` : '');
  return `${project.name}_${label}_间构成图`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) + '.' + extension;
}

export async function saveExport(extension, blob) {
  const id = state.view.projectId;
  const project = await api.project();
  if (project.id !== id || state.view.projectId !== id) throw new Error('工程已切换，请重新导出');
  const name = exportName(extension, project);
  if (window.callgraph?.saveExport) {
    return window.callgraph.saveExport({ name, bytes: new Uint8Array(await blob.arrayBuffer()), projectPath: project.path });
  }
  if (window.showSaveFilePicker) {
    // 浏览器的 picker id 会记住目录；使用工程路径而不是本次服务端口区分工程。
    const hash = [...project.path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
    const mime = { html: 'text/html', png: 'image/png', svg: 'image/svg+xml' }[extension];
    try {
      const file = await window.showSaveFilePicker({ id: 'cg-' + hash.toString(16), suggestedName: name,
        types: [{ description: extension.toUpperCase(), accept: { [mime]: ['.' + extension] } }] });
      const writer = await file.createWritable();
      await writer.write(blob); await writer.close();
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (error.name !== 'SecurityError') throw error;
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

export function buildPNG() {
  const canvas = document.createElement('canvas');
  canvas.width = els.cv.width; canvas.height = els.cv.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#F7F6F2'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(els.cv, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
