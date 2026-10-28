/** 将隐藏中间节点压缩成临时展示段，反向读取沿现有变量连线逆向播放。 */
export function pairFlowSegments(view, result) {
  if (!result) return [];
  const visible = new Set(view.nodes.map(n => n.id)), segments = new Map();
  const names = new Map(result.nodes.map(n => [n.id, n.name]));
  for (const path of result.paths) {
    let previous = -1;
    for (let i = 0; i < path.nodes.length; i++) {
      if (!visible.has(path.nodes[i])) continue;
      if (previous >= 0) {
        const from = path.nodes[previous], to = path.nodes[i], key = `${from}\0${to}`;
        if (!segments.has(key)) {
          const edge = view.edges.find(e => ((e.from === from && e.to === to) || (e.from === to && e.to === from)) &&
            (!path.versions || !e.versions || path.versions.some(v => e.versions.includes(v))));
          const points = edge?.points?.map(p => [...p]);
          if (points && edge.from !== from) points.reverse();
          segments.set(key, { from, to, points, via: path.nodes.slice(previous + 1, i).map(id => names.get(id) || id).join(' → ') });
        }
      }
      previous = i;
    }
  }
  return [...segments.values()];
}

function luminance(hex) {
  const rgb = hex.match(/[0-9a-f]{2}/gi)?.map(x => parseInt(x, 16) / 255);
  if (rgb?.length !== 3) return 0;
  return rgb.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
}

/** 选中线可自定义颜色，动态选取对比最强的脉冲色，另配双描边。 */
export function flowPulseColor(lineColor) {
  const l = luminance(lineColor);
  const contrast = color => { const n = luminance(color); return (Math.max(l, n) + 0.05) / (Math.min(l, n) + 0.05); };
  return ['#FF8A00', '#00E5FF', '#7C2D12'].sort((a, b) => contrast(b) - contrast(a))[0];
}
