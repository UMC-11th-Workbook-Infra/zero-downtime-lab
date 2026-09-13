import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBaseline } from '../src/analysis/baseline.js'

const T0 = 1_000_000
let seq = 0
function rec(offsetMs, outcome, failureType = null, durationMs = 100) {
  seq += 1
  return {
    seq, ts: T0 + offsetMs, status: null, durationMs,
    outcome, failureType, error: null,
  }
}

test('표본이 없으면 비율은 null 이다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  assert.deepEqual(b.result(), {
    complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null,
  })
})

test('베이스라인 창 안의 레코드로 실패율을 낸다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  b.push(rec(100, 'success'))
  b.push(rec(200, 'success'))
  b.push(rec(300, 'failure', 'timeout'))
  assert.equal(b.result().sampleCount, 4)
  assert.equal(b.result().failureRate, 0.25)
})

test('창을 넘어선 레코드는 반영하지 않는다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  b.push(rec(30_001, 'failure', 'timeout')) // 창 밖
  assert.equal(b.result().sampleCount, 1)
  assert.equal(b.result().failureRate, 0)
})

test('창 밖 레코드를 받으면 complete 가 된다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  assert.equal(b.result().complete, false)
  b.push(rec(30_001, 'success'))
  assert.equal(b.result().complete, true)
})

test('client 실패율을 따로 센다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'failure', 'client'))
  b.push(rec(100, 'failure', 'client'))
  b.push(rec(200, 'failure', 'timeout'))
  b.push(rec(300, 'success'))
  assert.equal(b.result().clientFailureRate, 0.5)
  assert.equal(b.result().failureRate, 0.75)
})

test('p95 는 응답을 받은 요청만으로 계산한다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success', null, 100))
  b.push(rec(100, 'success', null, 200))
  // 타임아웃은 durationMs 가 null 이므로 p95 표본에 들어가지 않는다
  b.push(rec(200, 'failure', 'timeout', null))
  assert.equal(b.result().p95, 200)
})
