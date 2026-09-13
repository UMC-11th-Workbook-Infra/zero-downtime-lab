import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarizeDurations } from '../src/analysis/percentiles.js'

test('빈 배열의 백분위수는 null 이다', () => {
  assert.equal(percentile([], 95), null)
})

test('원소가 하나면 어떤 백분위수든 그 값이다', () => {
  assert.equal(percentile([42], 50), 42)
  assert.equal(percentile([42], 99), 42)
})

test('nearest-rank 로 계산한다', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  assert.equal(percentile(values, 50), 50)  // ceil(0.5*10)-1 = 4
  assert.equal(percentile(values, 95), 100) // ceil(0.95*10)-1 = 9
  assert.equal(percentile(values, 99), 100)
})

test('p0 은 최솟값이다', () => {
  assert.equal(percentile([10, 20, 30], 0), 10)
})

test('summarizeDurations 는 정렬을 알아서 한다', () => {
  const out = summarizeDurations([300, 100, 200])
  assert.equal(out.p50, 200)
  assert.equal(out.max, 300)
  assert.equal(out.count, 3)
})

test('summarizeDurations 는 빈 입력에서 전부 null 을 준다', () => {
  assert.deepEqual(summarizeDurations([]), { p50: null, p95: null, p99: null, max: null, count: 0 })
})

test('summarizeDurations 는 입력 배열을 변형하지 않는다', () => {
  const input = [300, 100, 200]
  summarizeDurations(input)
  assert.deepEqual(input, [300, 100, 200])
})
