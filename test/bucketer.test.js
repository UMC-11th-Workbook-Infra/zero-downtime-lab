import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBucketer } from '../src/analysis/bucketer.js'

let seq = 0
function rec(ts, outcome, { failureType = null, durationMs = 100 } = {}) {
  seq += 1
  return { seq, ts, status: null, durationMs, outcome, failureType, error: null }
}

test('같은 초의 레코드는 버킷을 닫지 않는다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  assert.equal(b.push(rec(1_000_000, 'success')), null)
  assert.equal(b.push(rec(1_000_500, 'success')), null)
})

test('초가 넘어가면 직전 버킷이 닫혀서 나온다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  b.push(rec(1_000_500, 'success'))
  const bucket = b.push(rec(1_001_000, 'success'))
  assert.ok(bucket)
  assert.equal(bucket.tsSec, 1000)
  assert.equal(bucket.sent, 2)
  assert.equal(bucket.success, 2)
})

test('성공과 실패를 나눠 센다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  b.push(rec(1_000_100, 'failure', { failureType: 'timeout', durationMs: null }))
  b.push(rec(1_000_200, 'failure', { failureType: 'network', durationMs: null }))
  const bucket = b.flush()
  assert.equal(bucket.sent, 3)
  assert.equal(bucket.success, 1)
  assert.equal(bucket.failure, 2)
  assert.deepEqual(bucket.byType, { network: 1, timeout: 1, server: 0, client: 0 })
})

test('백분위수는 응답을 받은 요청만으로 계산한다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 100 }))
  b.push(rec(1_000_100, 'failure', { failureType: 'server', durationMs: 300 }))
  // 타임아웃은 응답이 없으므로 표본에서 빠진다
  b.push(rec(1_000_200, 'failure', { failureType: 'timeout', durationMs: null }))
  const bucket = b.flush()
  assert.equal(bucket.maxMs, 300)
  assert.equal(bucket.p50, 100) // 표본 [100, 300] 의 nearest-rank p50
})

test('slow 는 성공한 요청만 센다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 1500 }))   // 느린 성공 -> 센다
  b.push(rec(1_000_100, 'success', { durationMs: 500 }))    // 빠른 성공 -> 안 센다
  b.push(rec(1_000_200, 'failure', { failureType: 'server', durationMs: 2000 })) // 실패 -> 안 센다
  assert.equal(b.flush().slow, 1)
})

test('임계값과 같은 값은 느린 것으로 치지 않는다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 1000 }))
  assert.equal(b.flush().slow, 0)
})

test('레코드가 하나도 없으면 flush 는 null 이다', () => {
  assert.equal(createBucketer({ slowThresholdMs: 1000 }).flush(), null)
})

test('빈 초는 건너뛴다 (버킷을 만들지 않는다)', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  const bucket = b.push(rec(1_005_000, 'success')) // 5초 뒤
  assert.equal(bucket.tsSec, 1000)
  // 사이의 빈 초에 대한 버킷은 만들지 않는다. 화면에서 공백으로 보이는 것이 맞다.
})
