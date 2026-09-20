/**
 * 버킷을 그래프용 계열로 바꾼다.
 *
 * 버킷은 요청이 있었던 초에만 만들어진다.
 * 빠진 초를 채우지 않고 이어 그리면 끊긴 구간이 공백이 아니라
 * 직선으로 이어져 버려서, 정작 봐야 할 것이 안 보인다.
 *
 * @param {object[]} buckets tsSec 오름차순
 */
export function bucketsToSeries(buckets) {
  if (buckets.length === 0) return { x: [], success: [], failure: [], p95: [] }

  const bySec = new Map(buckets.map((b) => [b.tsSec, b]))
  const first = buckets[0].tsSec
  const last = buckets[buckets.length - 1].tsSec

  const x = []
  const success = []
  const failure = []
  const p95 = []

  for (let sec = first; sec <= last; sec += 1) {
    const b = bySec.get(sec)
    x.push(sec)
    success.push(b ? b.success : null)
    failure.push(b ? b.failure : null)
    p95.push(b ? b.p95 : null)
  }

  return { x, success, failure, p95 }
}

/**
 * 순단을 배경 음영 구간(초 단위)으로 바꾼다.
 * 진행 중인 순단은 끝을 null 로 둔다.
 */
export function outageBands(outages) {
  return outages.map((o) => [
    Math.floor(o.startTs / 1000),
    o.endTs === null ? null : Math.floor(o.endTs / 1000),
  ])
}
