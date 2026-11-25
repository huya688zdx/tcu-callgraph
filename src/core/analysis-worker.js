import { parentPort } from 'node:worker_threads';
import { scanSources, rebuildIndex } from './index.js';

async function restoreModel(model) {
  if (model._sourceBuffers) {
    const { SnapshotBuffers } = await import('./git-compare.js');
    const { repoRoot, entries } = model._sourceBuffers;
    model._sourceBuffers = new SnapshotBuffers(repoRoot, entries);
  }
  return rebuildIndex(model);
}

let flowModels = [];
let taskModel;
const jobs = {
  scan(root) {
    const warnings = [];
    return { files: scanSources(root, warnings), warnings };
  },
  async compare(args) {
    const { compareProjects } = await import('./compare.js');
    const result = await compareProjects(...args);
    for (const model of [result.model, result.beforeModel, result.afterModel]) delete model._index;
    return result;
  },
  async dataflow(model) {
    const { buildDataflowIndex } = await import('./dataflow.js');
    return buildDataflowIndex(await restoreModel(model));
  },
  async layout(args) {
    const { layoutElk } = await import('./layout-elk.js');
    return layoutElk(...args);
  },
  async cache({ model, bytes, maxBytes }) {
    const { packModel, unpackModel } = await import('./model-cache.js');
    if (!bytes) return packModel(model, maxBytes);
    const cached = unpackModel(bytes);
    const { externalDependenciesCurrent } = await import('./parsers/clang-config.js');
    return externalDependenciesCurrent(cached) ? cached : null;
  },
  async task({ model, from, onlyIds, headerId }) {
    const { detectTasks, readFunctionHeaderComment } = await import('./detect-tasks.js');
    if (model) taskModel = await restoreModel(model);
    return headerId ? readFunctionHeaderComment(taskModel, taskModel._index.byId.get(headerId))
      : detectTasks(taskModel, from, { onlyIds });
  },
  async flowchart({ models, id, opts, cachedHash }) {
    const { buildFlowchart, flowchartCacheHash } = await import('./flowchart.js');
    flowModels = await Promise.all(models.map((model, i) => model === undefined ? flowModels[i] : model && restoreModel(model)));
    const [model, otherModel] = flowModels;
    const fn = model._index.byId.get(id);
    const options = { ...opts, otherModel, otherFn: otherModel?._index.byId.get(id) };
    const hash = flowchartCacheHash(model, fn, options);
    if (hash === cachedHash) return { hash };
    return { hash, data: await buildFlowchart(model, fn, options) };
  },
};

parentPort.on('message', async ({ kind, args }) => {
  try {
    parentPort.postMessage({ data: await jobs[kind](args) });
  } catch (error) {
    parentPort.postMessage({ error: error.message || String(error) });
  }
});
