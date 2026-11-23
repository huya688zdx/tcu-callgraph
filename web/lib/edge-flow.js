// 布局与标注沿用函数 → 变量的存储键，读写箭头按数据实际传递的方向绘制。
export const isDataEdge = e => ['var', 'dataflow', 'df-read', 'df-write'].includes(e.kind);

export function edgeDirection(e) {
  if (e.kind !== 'var') return 'forward';
  if (e.via === '读写') return 'both';
  if (e.via === '读') return 'reverse';
  if (e.via === '写') return 'forward';
  return 'unknown';
}

export function edgeCaption(e, name) {
  const direction = edgeDirection(e);
  const arrow = { forward: ' → ', reverse: ' ← ', both: ' ↔ ', unknown: ' — ' }[direction];
  return name(e.from) + arrow + name(e.to);
}

export function svgMarkers(e, marker) {
  const direction = edgeDirection(e);
  return [
    direction === 'both' || direction === 'reverse' ? ` marker-start="url(#${marker})"` : '',
    direction === 'both' || direction === 'forward' ? ` marker-end="url(#${marker})"` : '',
  ].join('');
}
