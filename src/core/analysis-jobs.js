import { Worker } from 'node:worker_threads';

const queues = new Map();

/** 同类分析逐个执行，让重分析与 HTTP 请求分别使用自己的事件循环。 */
export function analysisJob(kind, prepare, { timeout = 300_000, signal } = {}) {
  if (!queues.has(kind)) queues.set(kind, { tail: Promise.resolve(), worker: null });
  const queue = queues.get(kind);
  const run = queue.tail.then(() => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (!queue.worker) {
      const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { execArgv: [] });
      queue.worker = { worker, state: {} };
      worker.on('error', () => {
        if (queue.worker?.worker === worker) queue.worker = null;
      });
      worker.on('exit', () => {
        if (queue.worker?.worker === worker) queue.worker = null;
      });
    }
    const { worker, state } = queue.worker;
    worker.ref();
    const finish = (error, data) => {
      clearTimeout(timer);
      worker.off('message', receive);
      worker.off('error', finish);
      worker.off('exit', exited);
      worker.unref();
      if (error) reject(error);
      else resolve(data);
    };
    const receive = message => finish(message.error ? new Error(message.error) : null, message.data);
    const exited = code => finish(new Error(`分析线程中断（${kind}: ${code}）`));
    const timer = setTimeout(() => {
      queue.worker = null;
      void worker.terminate();
      finish(new Error(`分析超时（${kind}）`));
    }, timeout);
    worker.once('message', receive);
    worker.once('error', finish);
    worker.once('exit', exited);
    try {
      worker.postMessage({ kind, args: prepare(state) });
    } catch (error) {
      queue.worker = null;
      void worker.terminate();
      finish(error);
    }
  }));
  queue.tail = run.catch(() => {});
  return run;
}

export function analysisModel(model) {
  const { _index, _dfPending, _sourceBuffers, ...raw } = model;
  return { ...raw, ...(_sourceBuffers && { _sourceBuffers: _sourceBuffers.toSnapshot() }) };
}
