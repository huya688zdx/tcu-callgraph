export function formatPeriod(us) {
  if (!(us > 0)) return '周期待确认';
  if (us % 1000000 === 0) return `${us / 1000000} s`;
  return us >= 1000 ? `${us / 1000} ms` : `${us} µs`;
}
