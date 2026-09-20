import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketsToSeries, outageBands } from '../public/lib/chart-data.js'

const bucket = (tsSec, success, failure, p95 = 90) => ({
  tsSec, sent: success + failure, success, failure,
  byType: { network: 0, timeout: failure, server: 0, client: 0 },
  slow: 0, p50: 50, p95, p99: 120, maxMs: 130,
})

test('빈 입력은 빈 배열이다', () => {
  assert.deepEqual(bucketsToSeries([]), { x: [], success: [], failure: [], p95: [] })
})

test('연속된 버킷은 그대로 나온다', () => {
  const out = bucketsToSeries([bucket(100, 20, 0), bucket(101, 19, 1)])
  assert.deepEqual(out.x, [100, 101])
  assert.deepEqual(out.success, [20, 19])
  assert.deepEqual(out.failure, [0, 1])
})

test('요청이 없던 초는 null 로 채운다', () => {
  // 100초와 104초 사이에 버킷이 없다 -> 끊긴 구간
  const out = bucketsToSeries([bucket(100, 20, 0), bucket(104, 20, 0)])
  assert.deepEqual(out.x, [100, 101, 102, 103, 104])
  assert.deepEqual(out.success, [20, null, null, null, 20])
  assert.deepEqual(out.failure, [0, null, null, null, 0])
  assert.deepEqual(out.p95, [90, null, null, null, 90])
})

test('p95 가 없는 버킷은 null 이다', () => {
  const out = bucketsToSeries([{ ...bucket(100, 0, 20), p95: null }])
  assert.deepEqual(out.p95, [null])
})

test('순단을 배경 음영 구간으로 바꾼다', () => {
  const bands = outageBands([
    { startTs: 100_000, endTs: 103_400, durationMs: 3400, failureCount: 68, byType: {}, ongoing: false },
  ])
  assert.deepEqual(bands, [[100, 103]])
})

test('진행 중인 순단은 끝이 null 이다', () => {
  const bands = outageBands([
    { startTs: 100_000, endTs: null, durationMs: 2000, failureCount: 40, byType: {}, ongoing: true },
  ])
  assert.deepEqual(bands, [[100, null]])
})
