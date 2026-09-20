import { randomUUID } from 'node:crypto'
import { createBucketer } from '../analysis/bucketer.js'
import { createOutageDetector } from '../analysis/outage-detector.js'
import { createBaseline } from '../analysis/baseline.js'
import { summarizeDurations } from '../analysis/percentiles.js'

const SUMMARY_INTERVAL_MS = 5000
/** 성공이 한 건도 없는 상태에서 이만큼 network 실패가 이어지면 대상에 닿지 않는 것으로 본다 */
const UNREACHABLE_STREAK = 10

/**
 * 프로버가 뱉는 레코드를 집계 단위들에 흘려보내고 이벤트로 알린다.
 *
 * @param {{ scenario: object, prober: object }} options
 */
export function createRun({ scenario, prober }) {
  const id = randomUUID()
  const listeners = { bucket: [], outage: [], summary: [], state: [] }

  const bucketer = createBucketer({ slowThresholdMs: scenario.analysis.slowThresholdMs })
  const detector = createOutageDetector({ minConsecutiveFailures: scenario.analysis.minConsecutiveFailures })
  /** 베이스라인은 첫 레코드가 와야 시작 시각을 안다 */
  let baseline = null

  const buckets = []
  const durations = []
  const totals = {
    sent: 0, success: 0, failure: 0,
    byType: { network: 0, timeout: 0, server: 0, client: 0 },
    slow: 0, dropped: 0,
  }

  let status = 'idle'
  let startedAt = null
  let finishedAt = null
  let sawSuccess = false
  let networkStreak = 0
  let summaryTimer = null

  function emit(event, payload) {
    // 사본을 순회한다. 리스너가 자기 자신이나 다른 리스너를 해제하면
    // 원본 배열이 순회 도중 줄어들어 다음 리스너를 건너뛴다.
    // SSE 핸들러가 실제로 state 리스너 안에서 구독을 전부 해제하므로
    // 뷰어가 둘 이상일 때 한쪽이 마지막 요약을 못 받고 연결이 매달린다.
    for (const cb of [...listeners[event]]) cb(payload)
  }

  function setStatus(next) {
    status = next
    emit('state', { status, runId: id })
  }

  function warnings() {
    const out = []
    if (totals.dropped > 0) out.push('dropped')
    if (status === 'unreachable') out.push('unreachable')
    const base = baseline?.result()
    if (base?.complete) {
      if (base.failureRate !== null && base.failureRate > 0.05) out.push('baseline-unstable')
      if (base.clientFailureRate !== null && base.clientFailureRate > 0.5) out.push('client-heavy')
    }
    return out
  }

  function summary() {
    const outages = detector.outages()
    return {
      runId: id,
      status,
      startedAt,
      finishedAt,
      scenarioName: scenario.name,
      totals: { ...totals, byType: { ...totals.byType } },
      percentiles: summarizeDurations(durations),
      baseline: baseline?.result() ?? {
        complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null,
      },
      outages,
      downtimeMs: outages.reduce((sum, o) => sum + o.durationMs, 0),
      warnings: warnings(),
    }
  }

  function onRecord(record) {
    if (baseline === null) {
      // 실제로 요청이 나가기 시작한 시점이 베이스라인의 기준이다
      baseline = createBaseline({ startTs: record.ts, baselineSec: scenario.analysis.baselineSec })
    }

    totals.sent += 1
    if (record.outcome === 'success') {
      totals.success += 1
      sawSuccess = true
      networkStreak = 0
      if (typeof record.durationMs === 'number' && record.durationMs > scenario.analysis.slowThresholdMs) {
        totals.slow += 1
      }
    } else {
      totals.failure += 1
      if (record.failureType in totals.byType) totals.byType[record.failureType] += 1
      networkStreak = record.failureType === 'network' ? networkStreak + 1 : 0
    }
    if (typeof record.durationMs === 'number') durations.push(record.durationMs)

    baseline.push(record)

    const bucket = bucketer.push(record)
    if (bucket !== null) {
      buckets.push(bucket)
      emit('bucket', bucket)
    }

    const outage = detector.push(record)
    if (outage !== null) emit('outage', outage)

    // 한 번도 성공한 적 없이 network 실패만 이어진다 = 애초에 닿은 적이 없다.
    // 그대로 durationSec 을 다 돌리는 것은 시간 낭비다.
    if (!sawSuccess && networkStreak >= UNREACHABLE_STREAK && status === 'running') {
      setStatus('unreachable')
      prober.stop()
    }
  }

  return {
    id,
    scenario,
    get status() { return status },
    get startedAt() { return startedAt },
    get finishedAt() { return finishedAt },
    buckets: () => buckets,
    outages: () => detector.outages(),
    summary,

    on(event, cb) {
      listeners[event].push(cb)
      return () => {
        const i = listeners[event].indexOf(cb)
        if (i >= 0) listeners[event].splice(i, 1)
      }
    },

    async start() {
      startedAt = Date.now()
      setStatus('running')
      summaryTimer = setInterval(() => emit('summary', summary()), SUMMARY_INTERVAL_MS)

      try {
        const stats = await prober.start(scenario, onRecord)
        totals.dropped = stats.dropped
      } finally {
        clearInterval(summaryTimer)
        const lastBucket = bucketer.flush()
        if (lastBucket !== null) {
          buckets.push(lastBucket)
          emit('bucket', lastBucket)
        }
        const lastOutage = detector.finish()
        if (lastOutage !== null) emit('outage', lastOutage)

        finishedAt = Date.now()
        if (status === 'running') setStatus('finished')
        emit('summary', summary())
      }
    },

    stop() {
      if (status === 'running') setStatus('stopped')
      prober.stop()
    },
  }
}
