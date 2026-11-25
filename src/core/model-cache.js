import { deserialize, serialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';

export function unpackModel(bytes) {
  return deserialize(gunzipSync(bytes));
}

export function packModel(model, maxBytes) {
  // 索引可从模型重建，手工节点属于单工程存档。
  const { _index, _dfPending, scheduleConfig, ...raw } = model;
  const plain = { ...raw };
  for (const key of ['files', 'functions', 'variables']) {
    if (Array.isArray(raw[key])) plain[key] = raw[key].filter(item => !item.manual);
  }
  if (raw._df) {
    plain._df = {
      ...raw._df,
      defs: (raw._df.defs || []).filter(item => !item.manual),
      byId: new Map([...(raw._df.byId || [])].filter(([, item]) => !item?.manual)),
    };
  }
  let packed;
  try { packed = serialize(plain); }
  catch { return { cached: false, reason: 'serialize' }; }
  const bytes = gzipSync(packed, { level: 1 });
  if (bytes.length > maxBytes) return { cached: false, reason: 'too-large', bytes: bytes.length };
  return { cached: true, rawBytes: packed.length, gzBytes: bytes.length, data: bytes };
}
