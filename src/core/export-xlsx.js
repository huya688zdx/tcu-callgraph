/**
 * Excel 导出（零依赖）
 * 多 sheet：概览 / 函数 / 调用边 / 宏定义 / 函数指针表 / 调用环
 */

import fs from 'node:fs';
import path from 'node:path';
import { stats, tarjan } from './index.js';
import { buildXlsx } from './xlsx.js';

const KIND_LABEL = {
  direct: '直接调用',
  macro: '经宏调用',
  fnptr: '函数指针',
  unknown: '未知',
};

export function exportXlsx(model, outPath) {
  const S = stats(model);
  const { byId, outAdj, inAdj } = model._index;
  const sheets = [];

  // ---- 概览 ----
  const overview = [
    ['工程根目录', model.root],
    ['文件数', S.files],
    ['函数数', S.functions],
    ['外部符号', S.externals],
    ['调用边总数', S.edges],
    ['经宏的边', S.macroEdges],
    ['函数指针边', S.fnptrEdges],
    ['宏定义数', S.macros],
    ['最大扇出', `${S.maxFanOut}  (${S.maxFanOutFn})`],
    ['最大扇入', `${S.maxFanIn}  (${S.maxFanInFn})`],
    ['调用环组数', S.cycles],
    ['解析耗时', `${S.elapsedMs} ms`],
    ['生成时间', new Date().toLocaleString('zh-CN')],
  ];
  sheets.push({
    name: '概览',
    columns: [
      { header: '指标', key: 'k', width: 24 },
      { header: '数值', key: 'v', width: 52 },
    ],
    rows: overview.map((r) => ({ k: r[0], v: r[1] })),
  });

  // ---- 函数 ----
  sheets.push({
    name: '函数',
    columns: [
      { header: '函数名', key: 'name', width: 30 },
      { header: '文件', key: 'file', width: 26 },
      { header: '行号', key: 'line', width: 8 },
      { header: '扇入', key: 'fanIn', width: 8 },
      { header: '扇出', key: 'fanOut', width: 8 },
      { header: 'static', key: 'isStatic', width: 8 },
      { header: '参数', key: 'params', width: 28 },
      { header: '条件编译', key: 'cond', width: 26 },
    ],
    rows: model.functions.map((f) => ({
      name: f.name,
      file: f.file,
      line: f.line,
      fanIn: (inAdj.get(f.id) || []).length,
      fanOut: (outAdj.get(f.id) || []).length,
      isStatic: f.isStatic ? 'Y' : '',
      params: (f.params || []).join(', '),
      cond: f.cond || '',
    })),
  });

  // ---- 调用边 ----
  sheets.push({
    name: '调用边',
    columns: [
      { header: '调用方', key: 'from', width: 30 },
      { header: '被调方', key: 'to', width: 30 },
      { header: '文件', key: 'file', width: 22 },
      { header: '调用点行号', key: 'line', width: 12 },
      { header: '类型', key: 'kind', width: 12 },
      { header: '宏 / 指针来源', key: 'via', width: 30 },
      { header: '条件编译', key: 'cond', width: 26 },
    ],
    rows: model.edges.map((e) => {
      const fromFn = byId.get(e.from);
      return {
        from: fromFn ? fromFn.name : e.from,
        to: e.callee,
        file: fromFn ? fromFn.file : '',
        line: e.line || '',
        kind: KIND_LABEL[e.kind] || e.kind,
        via: e.via || '',
        cond: e.cond || '',
      };
    }),
  });

  // ---- 宏定义 ----
  sheets.push({
    name: '宏定义',
    columns: [
      { header: '宏名', key: 'name', width: 24 },
      { header: '参数', key: 'params', width: 20 },
      { header: '宏体', key: 'raw', width: 64 },
      { header: '定义位置', key: 'where', width: 26 },
      { header: '条件编译', key: 'cond', width: 24 },
      { header: '展开出的调用', key: 'calls', width: 40 },
    ],
    rows: model.macros
      .filter((m) => m.raw && m.raw.trim())
      .map((m) => {
        const calls = [
          ...new Set(
            model.edges
              .filter((e) => e.macroChain && e.macroChain.includes(m.name))
              .map((e) => e.callee)
          ),
        ];
        return {
          name: m.name,
          params: m.params ? m.params.join(', ') : '(对象宏)',
          raw: m.raw,
          where: `${m.file}:${m.line}`,
          cond: m.cond || '',
          calls: calls.join(', '),
        };
      }),
  });

  // ---- 函数指针表 ----
  if (model.fnptrTables.length) {
    const rows = [];
    for (const t of model.fnptrTables) {
      for (const [k, v] of Object.entries(t.map)) {
        rows.push({ table: t.name, field: k, fn: v });
      }
    }
    sheets.push({
      name: '函数指针表',
      columns: [
        { header: '表变量', key: 'table', width: 24 },
        { header: '成员', key: 'field', width: 22 },
        { header: '实际函数', key: 'fn', width: 30 },
      ],
      rows,
    });
  }

  // ---- 调用环 ----
  const sccs = tarjan(model).filter((c) => c.length > 1);
  if (sccs.length) {
    sheets.push({
      name: '调用环',
      columns: [
        { header: '组', key: 'g', width: 8 },
        { header: '成员', key: 'm', width: 100 },
      ],
      rows: sccs.map((c, i) => ({ g: i + 1, m: c.map((x) => x.split('::').pop()).join(' → ') })),
    });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buildXlsx(sheets));
  return outPath;
}
