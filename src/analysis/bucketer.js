import { summarizeDurations } from './percentiles.js'

/** 새 버킷 누적기를 만든다 */
function newAccumulator(tsSec) {
  return {
    tsSec,
    sent: 0,
    success: 0,
    failure: 0,
    byType: { network: 0, timeout: 0, server: 0, client: 0 },
    slow: 0,
    durations: [],
  }
}

/** 누적기를 전송용 버킷으로 확정한다 */
function seal(acc) {
  const { p50, p95, p99, max } = summarizeDurations(acc.durations)
  return {
    tsSec: acc.tsSec,
    sent: acc.sent,
    success: acc.success,
    failure: acc.failure,
    byType: acc.byType,
    slow: acc.slow,
    p50, p95, p99,
    maxMs: max,
  }
}

/**
 * 레코드를 1초 단위로 접는다.
 *
 * @param {{ slowThresholdMs: number }} options
 */
export function createBucketer({ slowThresholdMs }) {
  let acc = null

  function add(record) {
    acc.sent += 1
    if (record.outcome === 'success') {
      acc.success += 1
      // slow 가 답해야 하는 질문은 "성공은 했는데 사용자가 기다렸는가" 다.
      // 실패한 요청이 느린 것은 이미 실패 건수에서 세고 있다.
      if (typeof record.durationMs === 'number' && record.durationMs > slowThresholdMs) {
        acc.slow += 1
      }
    } else {
      acc.failure += 1
      if (record.failureType in acc.byType) acc.byType[record.failureType] += 1
    }
    // 응답을 받은 요청만 지연 표본이 된다 (스펙 4.5)
    if (typeof record.durationMs === 'number') acc.durations.push(record.durationMs)
  }

  return {
    push(record) {
      const tsSec = Math.floor(record.ts / 1000)

      if (acc === null) {
        acc = newAccumulator(tsSec)
        add(record)
        return null
      }

      if (tsSec === acc.tsSec) {
        add(record)
        return null
      }

      // 초가 넘어갔다. 직전 버킷을 닫고 새로 시작한다.
      // 사이에 빈 초가 있어도 버킷을 만들지 않는다 — 화면에서 공백으로 보이는 것이 맞다.
      const sealed = seal(acc)
      acc = newAccumulator(tsSec)
      add(record)
      return sealed
    },

    flush() {
      if (acc === null) return null
      const sealed = seal(acc)
      acc = null
      return sealed
    },
  }
}
