import { formatCount, formatDuration, formatMs, formatPercent, formatClock } from './format.js'

/** 0이 아닌 실패 유형만 "timeout 61, network 7" 형태로 */
function typeBreakdown(byType) {
  const parts = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
  return parts.join(', ')
}

/**
 * 요약을 타일 배열로 만든다.
 *
 * 모든 수치에 베이스라인 대비 델타를 붙이는 것이 핵심이다.
 * 노트북과 대상 사이 인터넷 노이즈는 없앨 수 없으므로,
 * 절대값이 아니라 평소와 얼마나 벌어졌는지로 읽어야 한다.
 *
 * baseline.complete 가 false 인 동안은 표본이 몇 건뿐이라 "평소" 라고
 * 부를 수 없다 — 값이 null 이 아니라고 바로 보여주면, 측정 시작 1초 뒤
 * 표본 20개로 만든 수치를 "평소"라고 단언하는 꼴이 된다. complete 가 될
 * 때까지는 측정 중이라고 솔직하게 표시한다.
 */
export function summaryTiles(summary) {
  const { totals, percentiles, baseline, outages, downtimeMs } = summary
  const failureRate = totals.sent > 0 ? totals.failure / totals.sent : null

  const baselineSub = (value, formatter) => {
    if (!baseline.complete) return '평소 측정 중'
    return value !== null ? `평소 ${formatter(value)}` : ''
  }

  return [
    { label: '총 요청', value: formatCount(totals.sent), sub: '' },
    { label: '실패', value: formatCount(totals.failure), sub: typeBreakdown(totals.byType) },
    {
      label: '실패율',
      value: formatPercent(failureRate),
      sub: baselineSub(baseline.failureRate, formatPercent),
    },
    { label: '순단', value: `${outages.length}회`, sub: '' },
    { label: '총 다운타임', value: formatDuration(downtimeMs), sub: '' },
    {
      label: 'p95 지연',
      value: formatMs(percentiles.p95),
      sub: baselineSub(baseline.p95, formatMs),
    },
    { label: '느린 응답', value: formatCount(totals.slow), sub: '임계값 초과' },
  ]
}

/** 순단 하나를 한 줄로 */
export function outageLine(outage) {
  const head = `${formatClock(outage.startTs)}부터 ${formatDuration(outage.durationMs)}, ${formatCount(outage.failureCount)}건 실패`
  const detail = typeBreakdown(outage.byType)
  const tail = outage.ongoing ? ' — 진행 중' : ''
  return detail === '' ? head + tail : `${head} (${detail})${tail}`
}
