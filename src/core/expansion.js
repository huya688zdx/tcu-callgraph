/** 单函数局部展开参数。限制深度和条数，避免误操作展开整个大工程。 */
export function normalizeExpansions(value = []) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('局部展开最多支持 128 个函数');
  const result = new Map();
  for (const item of value) {
    if (!item || typeof item.root !== 'string' || !item.root || item.root.length > 2048 ||
        ![item.up, item.down].every((n) => Number.isInteger(n) && n >= 0 && n <= 20)) {
      throw new Error('局部展开需要函数及 0 到 20 的整数层数');
    }
    const previous = result.get(item.root);
    result.set(item.root, { root: item.root,
      up: Math.max(previous?.up || 0, item.up), down: Math.max(previous?.down || 0, item.down) });
  }
  return [...result.values()];
}
