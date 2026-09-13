import { summarizeDurations } from './percentiles.js'

/**
 * 실행 시작 직후 구간을 평상시 기준값으로 잡는다.
 *
 * 노트북과 대상 사이 인터넷 구간 노이즈는 없앨 수 없으므로,
 * 절대값 대신 이 기준과의 델타로 읽게 하는 것이 목적이다.
 *
 * @param {{ startTs: number, baselineSec: number }} options
 */
export function createBaseline({ startTs, baselineSec }) {
  const windowEndTs = startTs + baselineSec * 1000
  let total = 0
  let failures = 0
  let clientFailures = 0
  let complete = false
  const durations = []

  return {
    push(record) {
      if (record.ts > windowEndTs) {
        // 창을 넘어섰다. 이후 레코드는 기준값에 반영하지 않는다.
        complete = true
        return
      }
      total += 1
      if (record.outcome === 'failure') {
        failures += 1
        if (record.failureType === 'client') clientFailures += 1
      }
      // 응답을 받은 요청만 지연 표본이 된다 (스펙 4.5)
      if (typeof record.durationMs === 'number') durations.push(record.durationMs)
    },

    result() {
      return {
        complete,
        sampleCount: total,
        failureRate: total > 0 ? failures / total : null,
        clientFailureRate: total > 0 ? clientFailures / total : null,
        p95: summarizeDurations(durations).p95,
      }
    },
  }
}
