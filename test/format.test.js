import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatPercent, formatCount, formatClock, formatMs } from '../public/lib/format.js'

test('1초 미만은 소수점 한 자리로 쓴다', () => {
  assert.equal(formatDuration(340), '0.3초')
})

test('1분 미만은 초로 쓴다', () => {
  assert.equal(formatDuration(3400), '3.4초')
  assert.equal(formatDuration(12_000), '12.0초')
})

test('1분 이상은 분과 초로 나눠 쓴다', () => {
  assert.equal(formatDuration(72_000), '1분 12초')
  assert.equal(formatDuration(120_000), '2분 0초')
})

test('0 은 0초다', () => {
  assert.equal(formatDuration(0), '0.0초')
})

test('비율은 백분율로 쓴다', () => {
  assert.equal(formatPercent(0.002), '0.2%')
  assert.equal(formatPercent(1), '100%')
  assert.equal(formatPercent(0), '0%')
})

test('비율이 null 이면 대시로 쓴다', () => {
  assert.equal(formatPercent(null), '—')
})

test('건수에 천 단위 구분을 넣는다', () => {
  assert.equal(formatCount(1234), '1,234')
  assert.equal(formatCount(0), '0')
})

test('밀리초가 null 이면 대시로 쓴다', () => {
  assert.equal(formatMs(null), '—')
  assert.equal(formatMs(1234), '1,234ms')
})

test('시각은 시:분:초로 쓴다', () => {
  // 로컬 타임존에 의존하지 않도록 형식만 확인한다
  assert.match(formatClock(1_700_000_000_000), /^\d{2}:\d{2}:\d{2}$/)
})
