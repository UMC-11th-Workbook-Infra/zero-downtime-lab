/**
 * nearest-rank 방식 백분위수.
 *
 * 보간하지 않으므로 반환값은 항상 실제로 관측된 값이다.
 * 표본이 적은 구간에서 없던 숫자가 만들어지지 않는다.
 *
 * @param {number[]} sortedValues 오름차순 정렬된 값
 * @param {number} p 0~100
 * @returns {number|null} 표본이 없으면 null
 */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1
  const index = Math.min(Math.max(rank, 0), sortedValues.length - 1)
  return sortedValues[index]
}

/**
 * 응답 시간 배열을 요약한다. 정렬은 내부에서 하고 입력 배열은 건드리지 않는다.
 *
 * @param {number[]} values
 * @returns {{ p50: number|null, p95: number|null, p99: number|null, max: number|null, count: number }}
 */
export function summarizeDurations(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    count: sorted.length,
  }
}
