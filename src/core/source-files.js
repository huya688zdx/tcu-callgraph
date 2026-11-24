import fs from 'node:fs';
import path from 'node:path';

export const SRC_EXT = /\.(c|cc|cpp)$/i;
export const HDR_EXT = /\.(h|hh|hpp)$/i;

/**
 * 源码解码：先按 UTF-8 严格解码，失败则回退 CP932(Shift-JIS)。
 * 汽车电子不少 TCU 工程出自日文环境，源码是 CP932 编码，
 * 直接按 UTF-8 读会把注释和字符串里的日文变成乱码。
 * 同时兼容 UTF-8 BOM / UTF-16 BOM。
 */
export function decodeSource(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 不是合法 UTF-8，继续尝试 CP932
  }
  try {
    return new TextDecoder('shift_jis').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

export function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.test(e.name) || HDR_EXT.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * 一次扫描取得路径、大小与 mtime，供解析缓存和冷启动共用。
 */
export function scanSources(root, warnings = []) {
  const out = [];
  for (const abs of listSourceFiles(root)) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    let st;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      warnings.push({ file: rel, error: `读取失败：${err.message}` });
      continue;
    }
    out.push({
      abs,
      rel,
      bytes: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      isHeader: HDR_EXT.test(abs),
    });
  }
  return out;
}
