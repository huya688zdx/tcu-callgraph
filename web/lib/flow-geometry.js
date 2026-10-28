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
