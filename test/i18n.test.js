import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getLang, setLang, SUPPORTED_LANGS, t as translate } from '../web/i18n.js';

const web = new URL('../web/', import.meta.url);
const source = path => fs.readFileSync(new URL(path, web), 'utf8');
const placeholders = text => [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), match => match[1]))].sort();

test('三语词条键集合及占位符一致，前端静态引用均可翻译', t => {
  assert.deepEqual(SUPPORTED_LANGS, ['zh-CN', 'ja', 'en']);
  t.after(() => setLang('zh-CN'));
  const dictionaryRows = Array.from(source('i18n.js').matchAll(/^  (\["[^"]+", .*\]),$/gm), match => JSON.parse(match[1]));
  assert.ok(dictionaryRows.length > 300);
  const keys = new Set(dictionaryRows.map(([key]) => key));
  assert.equal(keys.size, dictionaryRows.length, '词条键不能重复');
  for (const [key, ...translations] of dictionaryRows) {
    assert.equal(translations.length, SUPPORTED_LANGS.length, key);
    for (const [index, text] of translations.entries()) {
      assert.ok(text?.trim(), key);
      assert.deepEqual(placeholders(text), placeholders(translations[0]), key);
      setLang(SUPPORTED_LANGS[index]);
      assert.equal(translate(key), text, key);
    }
  }

  const files = ['app.js', ...fs.readdirSync(new URL('lib/', web)).filter(file => file.endsWith('.js')).map(file => 'lib/' + file)];
  const references = [
    ...Array.from(source('index.html').matchAll(/\bdata-i18n(?:-[\w-]+)?=["']([\w.-]+)["']/g), match => ['index.html', match[1]]),
    ...files.flatMap(file => Array.from(source(file).matchAll(/\bt\(\s*['"]([\w.-]+)['"]\s*(?=[,)]|\s*:)/g), match => [file, match[1]])),
  ];
  for (const [file, key] of references) assert.ok(keys.has(key), `${file}: ${key}`);
});

test('切换语言写入本地存储并立即更新文案与语言事件', t => {
  const stored = new Map();
  const doc = new EventTarget();
  const entry = { dataset: { i18n: 'style.language' } };
  doc.documentElement = { lang: 'zh-CN' };
  doc.querySelectorAll = selector => selector === '[data-i18n]' ? [entry] : [];
  for (const [key, value] of [
    ['document', doc],
    ['localStorage', { setItem: (name, value) => stored.set(name, value) }],
  ]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const events = [];
  doc.addEventListener('callgraph:langchange', event => events.push(event.detail.lang));
  setLang('ja');
  assert.equal(entry.textContent, '表示言語');
  setLang('en');
  assert.equal(stored.get('callgraph.language'), 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(entry.textContent, 'Interface language');
  assert.equal(translate('compare.point.affected', { n: 5 }), '5 affected');
  setLang('unknown');
  assert.equal(getLang(), 'en');
  assert.deepEqual(events, ['ja', 'en']);
});

test('画布时间轴的动态类型和回看提示在三种语言下均可显示', t => {
  t.after(() => setLang('zh-CN'));
  for (const lang of SUPPORTED_LANGS) {
    setLang(lang);
    for (const key of ['timeline.kindCanvas', 'timeline.kindClearCanvas']) {
      assert.notEqual(translate(key), key);
    }
    for (const key of ['timeline.reviewSnapshot', 'timeline.reviewOverlay']) {
      const message = translate(key, { time: '10:20:30', n: 123 });
      assert.match(message, /10:20:30/);
      assert.match(message, /123/);
      assert.doesNotMatch(message, /\{\w+\}/);
    }
  }
});
