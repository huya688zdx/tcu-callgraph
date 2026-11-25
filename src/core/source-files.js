import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';

export const SRC_EXT = /\.(c|cc|cpp)$/i;
export const HDR_EXT = /\.(h|hh|hpp)$/i;

const CJK_KANA = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g;
const MOJIBAKE_HINT = /[\u0080-\u009f\ufffd]/;

function preferCp932OverUtf8(buf, hint) {
  if (!buf.some((b) => b >= 0x80)) return false;
  let sjis;
  try {
    sjis = new TextDecoder('shift_jis', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return false;
  }
  const sjisCjk = (sjis.match(CJK_KANA) || []).length;
  if (!sjisCjk) return false;
  const utf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buf);
  if (MOJIBAKE_HINT.test(utf8)) return true;
  if (hint === 'cp932') {
    const utf8Cjk = (utf8.match(CJK_KANA) || []).length;
    if (sjisCjk >= utf8Cjk) return true;
  }
  return false;
}

/**
 * 先识别文件 BOM。无 BOM 时，已知 CP932 的工程可显式指定，否则自动识别 UTF-8 与 CP932。
 * 同一文件的各个字节切片共用此解码器，防止将局部的半角假名重新猜成 UTF-8。
 */
export function sourceDecoder(buf, preferred = 'auto', { fatal = false, hint = null } = {}) {
  if (!['auto', 'cp932', 'utf-8'].includes(preferred)) throw new Error('源码编码须为 auto、cp932 或 utf-8');
  let encoding = preferred, bomLength = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'utf-8';
    bomLength = 3;
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    bomLength = 2;
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    encoding = 'utf-16be';
    bomLength = 2;
  } else if (preferred === 'auto') {
    encoding = isUtf8(buf) && !preferCp932OverUtf8(buf, hint) ? 'utf-8' : 'cp932';
  }
  // 调用方只在文件开头跳过 BOM，Clang 的字节范围始终基于原文件。
  const decoder = new TextDecoder(encoding === 'cp932' ? 'shift_jis' : encoding, { fatal, ignoreBOM: true });
  return { encoding, bomLength, decode: bytes => decoder.decode(bytes) };
}

export function decodeSource(buf, options = {}) {
  const decoder = sourceDecoder(buf, 'auto', options);
  return decoder.decode(buf.subarray(decoder.bomLength));
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
