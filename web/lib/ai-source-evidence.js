// Snippets are snapshots of successful indexed source reads. Keep complete lines only.
export function sourceEvidence(items, budget = 8000) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.file !== 'string' || !item.file || item.file.length > 512 ||
        typeof item.source !== 'string' || !Number.isSafeInteger(item.startLine) || item.startLine < 1 ||
        !Number.isSafeInteger(item.endLine) || item.endLine < item.startLine) continue;
    const lines = [];
    for (const line of item.source.split('\n').slice(0, Math.min(120, item.endLine - item.startLine + 1))) {
      if (line.length + 1 > budget) break;
      budget -= line.length + 1;
      lines.push(line);
    }
    if (!lines.length) continue;
    result.push({ file: item.file, startLine: item.startLine, endLine: item.startLine + lines.length - 1,
      source: lines.join('\n'), ...(['before', 'after'].includes(item.traceVersion) ? { traceVersion: item.traceVersion } : {}) });
    if (result.length === 6 || budget <= 0) break;
  }
  return result;
}

export function evidenceForTool(name, output) {
  if (!output?.ok || !['read_function', 'read_source'].includes(name)) return [];
  return sourceEvidence(output.batch ? output.items : [output]);
}

export function boundSavedEvidence(threads, activeId) {
  let budget = 150_000;
  const sorted = [...threads].sort((a, b) =>
    Number(b.id === activeId) - Number(a.id === activeId) || b.updatedAt - a.updatedAt);
  for (const thread of sorted) {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const m = thread.messages[i];
      if (!m.evidence) continue;
      const items = sourceEvidence(m.evidence, Math.min(budget, 8000));
      if (items.length) {
        m.evidence = items;
        for (const item of items) budget -= item.source.length + 1;
      } else delete m.evidence;
    }
  }
}
