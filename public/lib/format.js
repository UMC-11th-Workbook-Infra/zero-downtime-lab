/** 지속 시간을 사람이 읽는 형태로 (순단 목록과 다운타임 합계에 쓴다) */
export function formatDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}분 ${seconds}초`
}

/** 0~1 비율을 백분율로. 표본이 없으면 대시 */
export function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  if (rate === 0) return '0%'
  if (rate >= 0.1) return `${(rate * 100).toFixed(0)}%`
  return `${(rate * 100).toFixed(1)}%`
}

export function formatCount(n) {
  return Number(n ?? 0).toLocaleString('ko-KR')
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return '—'
  return `${Number(ms).toLocaleString('ko-KR')}ms`
}

/** epoch ms 를 시:분:초로. 순단이 언제 시작됐는지 보여줄 때 쓴다 */
export function formatClock(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
