import { state } from './state.js';
import { api } from './api.js';
import { draw } from './render.js';
import { hooks } from './hooks.js';
import { pushHistory } from './history.js';
let nameWrites = Promise.resolve();

export async function setNodeName(n, mode) {
  if (!n?.headerSymbol || state.at > 0 || state.view?.comparison) return;
  const view = state.view;
  const override = mode === 'default' ? null : mode;
  const pending = nameWrites.then(() => api.overlay({ nodeId: n.id, data: { nameMode: override }, projectId: view.projectId }));
  nameWrites = pending.catch(() => {});
  const result = await pending;
  if (!result?.ok || state.view !== view) return;
  n = view.nodes.find((node) => node.id === n.id);
  if (!n) return;
  n.nameModeOverride = override;
  n.nameMode = override || view.macroNameMode || 'alias';
  n.displayName = n.nameMode === 'target' ? n.targetNames.join(' / ') : n.name;
  draw();
  pushHistory();
  if (state.selected === n.id) hooks.renderDetail(n.id);
}
