import { state } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { hooks } from './hooks.js';
import { pushHistory } from './history.js';
let nameWrites = Promise.resolve();

export async function setNodeName(n, mode) {
  if (!n?.headerSymbol || state.at > 0 || state.view?.comparison) return;
  const view = state.view;
  const pending = nameWrites.then(() => api.overlay({ nodeId: n.id, data: { nameMode: mode }, projectId: view.projectId }));
  nameWrites = pending.catch(() => {});
  const result = await pending;
  if (!result?.ok || state.view !== view) return;
  n.nameMode = mode;
  n.displayName = mode === 'target' ? n.targetNames.join(' / ') : n.name;
  draw();
  pushHistory();
  if (state.selected === n.id) hooks.renderDetail(n.id);
}
