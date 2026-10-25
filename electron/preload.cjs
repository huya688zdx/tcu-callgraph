const { contextBridge, ipcRenderer } = require('electron');

// 沙箱页面只通过明确的 IPC 打开原生选择框，不能自行读写磁盘。
contextBridge.exposeInMainWorld('callgraph', {
  pickFolder: () => ipcRenderer.invoke('cg:pick-folder'),
  openProjectFolder: (id) => ipcRenderer.invoke('cg:open-project-folder', id),
  saveExport: (payload) => ipcRenderer.invoke('cg:save-export', payload),
});
