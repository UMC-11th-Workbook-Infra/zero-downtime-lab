import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRun } from '../src/run/run.js'

const T0 = 1_700_000_000_000

function rec(seq, offsetMs, outcome, { failureType = null, durationMs = 50 } = {}) {
  return {
    seq, ts: T0 + offsetMs, status: outcome === 'success' ? 200 : 500,
    durationMs, outcome, failureType, error: null,
  }
}

/** 미리 정해둔 레코드를 그대로 흘려보내는 가짜 프로버 */
function fakeProber(records, { dropped = 0 } = {}) {
  const state = { stopped: false, delivered: 0 }
  return {
    state,
    async start(scenario, onRecord) {
      for (const r of records) {
        if (state.stopped) break
        state.delivered += 1
        onRecord(r)
      }
      return { fired: state.delivered, dropped }
    },
    stop() { state.stopped = true },
  }
}

const scenario = {
  name: '테스트',
  target: { url: 'http://x/y', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 },
  success: { statusCodes: [200] },
  load: { rps: 20, durationSec: 10 },
  analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
}

test('레코드를 집계해 총계를 낸다', async () => {
  const records = [
    rec(1, 0, 'success'),
    rec(2, 100, 'success'),
    rec(3, 200, 'failure', { failureType: 'server', durationMs: 20 }),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()

  const s = run.summary()
  assert.equal(s.totals.sent, 3)
  assert.equal(s.totals.success, 2)
  assert.equal(s.totals.failure, 1)
  assert.equal(s.totals.byType.server, 1)
  assert.equal(s.status, 'finished')
})

test('초가 넘어가면 bucket 이벤트가 나온다', async () => {
  const records = [rec(1, 0, 'success'), rec(2, 1500, 'success'), rec(3, 2500, 'success')]
  const seen = []
  const run = createRun({ scenario, prober: fakeProber(records) })
  run.on('bucket', (b) => seen.push(b))
  await run.start()
  assert.ok(seen.length >= 2, `버킷 ${seen.length}개는 너무 적다`)
  assert.equal(run.buckets().length, seen.length)
})

test('순단이 감지되면 outage 이벤트와 다운타임이 나온다', async () => {
  const records = [
    rec(1, 0, 'success'),
    rec(2, 1000, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(3, 1050, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(4, 1100, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(5, 4000, 'success'),
  ]
  const seen = []
  const run = createRun({ scenario, prober: fakeProber(records) })
  run.on('outage', (o) => seen.push(o))
  await run.start()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].durationMs, 4000)
  assert.equal(run.summary().downtimeMs, 4000)
})

test('성공 없이 network 실패 10건이면 자동 중단된다', async () => {
  const records = Array.from({ length: 30 }, (_, i) =>
    rec(i + 1, i * 50, 'failure', { failureType: 'network', durationMs: null }))
  const prober = fakeProber(records)
  const run = createRun({ scenario, prober })
  await run.start()

  assert.equal(run.status, 'unreachable')
  assert.ok(prober.state.stopped, '프로버를 멈춰야 한다')
  assert.ok(prober.state.delivered < 30, '30건을 다 소비하면 안 된다')
  assert.ok(run.summary().warnings.includes('unreachable'))
})

test('한 번 성공한 뒤의 연속 실패는 자동 중단하지 않는다', async () => {
  const records = [
    rec(1, 0, 'success'),
    ...Array.from({ length: 20 }, (_, i) =>
      rec(i + 2, (i + 1) * 50, 'failure', { failureType: 'network', durationMs: null })),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.equal(run.status, 'finished')
})

test('dropped 가 있으면 경고가 붙는다', async () => {
  const run = createRun({ scenario, prober: fakeProber([rec(1, 0, 'success')], { dropped: 4 }) })
  await run.start()
  assert.equal(run.summary().totals.dropped, 4)
  assert.ok(run.summary().warnings.includes('dropped'))
})

test('베이스라인 실패율이 5%를 넘으면 경고가 붙는다', async () => {
  // 베이스라인 창(30초) 안에서 10건 중 2건 실패 = 20%
  const records = [
    ...Array.from({ length: 8 }, (_, i) => rec(i + 1, i * 100, 'success')),
    rec(9, 900, 'failure', { failureType: 'server', durationMs: 10 }),
    rec(10, 1000, 'failure', { failureType: 'server', durationMs: 10 }),
    rec(11, 31_000, 'success'), // 창 밖 -> complete 로 만든다
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.ok(run.summary().warnings.includes('baseline-unstable'))
})

test('베이스라인 client 실패가 절반을 넘으면 경고가 붙는다', async () => {
  const records = [
    ...Array.from({ length: 6 }, (_, i) => rec(i + 1, i * 100, 'failure', { failureType: 'client', durationMs: 10 })),
    ...Array.from({ length: 4 }, (_, i) => rec(i + 7, 700 + i * 100, 'success')),
    rec(11, 31_000, 'success'),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.ok(run.summary().warnings.includes('client-heavy'))
})

test('state 이벤트로 상태 변화를 알린다', async () => {
  const seen = []
  const run = createRun({ scenario, prober: fakeProber([rec(1, 0, 'success')]) })
  run.on('state', (s) => seen.push(s.status))
  await run.start()
  assert.deepEqual(seen, ['running', 'finished'])
})

test('백분위수는 응답을 받은 요청만으로 계산한다', async () => {
  const records = [
    rec(1, 0, 'success', { durationMs: 100 }),
    rec(2, 100, 'success', { durationMs: 300 }),
    rec(3, 200, 'failure', { failureType: 'timeout', durationMs: null }),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.equal(run.summary().percentiles.count, 2)
  assert.equal(run.summary().percentiles.max, 300)
})
