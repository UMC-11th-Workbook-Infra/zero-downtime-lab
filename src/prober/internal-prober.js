import { classify } from './classify.js'
import { renderTemplate, renderHeaders } from './request-template.js'
import { createScheduler } from './scheduler.js'
import { createSequenceBuffer } from './sequence-buffer.js'

/**
 * Node 가 직접 요청을 쏘는 프로버.
 *
 * @param {{ fetchImpl?: typeof fetch }} deps
 */
export function createInternalProber({ fetchImpl = fetch } = {}) {
  let scheduler = null
  let stopRequested = false
  let resolveDone = null

  /** 요청 1건을 보내고 결과를 분류 가능한 형태로 돌려준다 */
  async function sendOnce(scenario, seq) {
    const now = Date.now()
    const ctx = { counter: seq, now }
    const { url, method, headers, body, timeoutMs } = scenario.target

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    try {
      const res = await fetchImpl(url, {
        method,
        headers: renderHeaders(headers, ctx),
        // GET/HEAD 에는 바디를 붙이지 않는다
        body: method === 'GET' || method === 'HEAD' ? undefined : renderTemplate(body ?? '', ctx),
        signal: controller.signal,
        redirect: 'manual', // 3xx 를 따라가지 않는다 (스펙 8장)
      })
      // 커넥션을 반납하려면 본문을 소비해야 한다
      await res.arrayBuffer().catch(() => {})
      return { status: res.status, durationMs: Date.now() - startedAt, error: null }
    } catch (err) {
      if (controller.signal.aborted) {
        return { timedOut: true, durationMs: null, error: 'timeout' }
      }
      return {
        errorCode: err?.cause?.code ?? err?.code ?? 'UNKNOWN',
        durationMs: null,
        error: String(err?.cause?.code ?? err?.message ?? err),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 스케줄러를 멈추라고 표시한다. 남은 in-flight 는 각자 끝나기를 기다린다. */
  function requestStop() {
    stopRequested = true
    if (scheduler !== null) scheduler.stop()
  }

  return {
    async start(scenario, onRecord) {
      stopRequested = false
      const { rps, durationSec } = scenario.load
      const { timeoutMs } = scenario.target
      const successCodes = scenario.success.statusCodes

      const buffer = createSequenceBuffer({ firstSeq: 1 })
      /** 발사 시각을 seq 별로 기억해 둔다 (레코드의 ts 로 쓴다) */
      const firedAt = new Map()

      scheduler = createScheduler({
        intervalMs: 1000 / rps,
        maxInFlight: Math.ceil(rps * (timeoutMs / 1000) * 2),
      })

      const done = new Promise((resolve) => { resolveDone = resolve })

      scheduler.start(async (seq) => {
        firedAt.set(seq, Date.now())
        const result = await sendOnce(scenario, seq)
        const { outcome, failureType } = classify(result, successCodes)

        const record = {
          seq,
          ts: firedAt.get(seq),
          status: typeof result.status === 'number' ? result.status : null,
          durationMs: result.durationMs,
          outcome,
          failureType,
          error: result.error ?? null,
        }
        firedAt.delete(seq)

        // 완료 순서가 아니라 발사 순서로 내보낸다
        for (const ordered of buffer.push(record)) onRecord(ordered)
      })

      const durationTimer = setTimeout(requestStop, durationSec * 1000)

      /** 스케줄러를 멈춘 뒤 in-flight 가 정리될 때까지 기다린다 */
      const waitIdle = setInterval(() => {
        if (!stopRequested) return
        if (scheduler.stats().inFlight > 0) return
        clearInterval(waitIdle)
        clearTimeout(durationTimer)
        for (const ordered of buffer.flush()) onRecord(ordered)
        resolveDone({ fired: scheduler.stats().fired, dropped: scheduler.stats().dropped })
      }, 20)

      return done
    },

    stop: requestStop,
  }
}
