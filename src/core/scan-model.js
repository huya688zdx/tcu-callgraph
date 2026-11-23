import { loadModel } from './index.js';

// 只传回可缓存的模型。进程结束后由系统回收扫描期的内存。
process.once('message', ({ target, scan }) => {
  let result;
  try {
    const { _index, ...model } = loadModel(target, scan);
    result = { model };
  } catch (error) {
    result = { error: error.message };
  }
  if (process.connected) process.send(result, () => {
    if (process.connected) process.disconnect();
  });
});
