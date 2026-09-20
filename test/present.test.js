import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summaryTiles, outageLine } from '../public/lib/present.js'
import { warningMessage } from '../public/lib/warnings.js'

const summary = {
  runId: 'r1', status: 'finished', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_300_000,
  totals: {
    sent: 6000, success: 5932, failure: 68,
    byType: { network: 7, timeout: 61, server: 0, client: 0 },
    slow: 12, dropped: 0,
  },
  percentiles: { p50: 84, p95: 190, p99: 420, max: 980, count: 5939 },
  baseline: { complete: true, sampleCount: 600, failureRate: 0.002, clientFailureRate: 0, p95: 150 },
  outages: [{ startTs: 1_700_000_060_000, endTs: 1_700_000_063_400, durationMs: 3400, failureCount: 68, byType: { network: 7, timeout: 61, server: 0, client: 0 }, ongoing: false }],
  downtimeMs: 3400,
  warnings: [],
}

test('타일에 총 요청과 실패 건수가 들어간다', () => {
  const tiles = summaryTiles(summary)
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]))
  assert.equal(byLabel['총 요청'].value, '6,000')
  assert.equal(byLabel['실패'].value, '68')
})

test('실패 타일에 유형별 내역이 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '실패')
  assert.ok(tile.sub.includes('timeout 61'))
  assert.ok(tile.sub.includes('network 7'))
})

test('실패 타일에 베이스라인 대비 델타가 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '실패율')
  assert.ok(tile.sub.includes('평소 0.2%'), `받은 값: ${tile.sub}`)
})

test('순단과 총 다운타임 타일이 있다', () => {
  const byLabel = Object.fromEntries(summaryTiles(summary).map((t) => [t.label, t]))
  assert.equal(byLabel['순단'].value, '1회')
  assert.equal(byLabel['총 다운타임'].value, '3.4초')
})

test('p95 타일에 베이스라인 p95 가 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === 'p95 지연')
  assert.equal(tile.value, '190ms')
  assert.ok(tile.sub.includes('150ms'))
})

test('지연 임계값 초과 건수 타일이 있다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '느린 응답')
  assert.equal(tile.value, '12')
})

test('순단 한 줄은 시작 시각, 지속 시간, 실패 건수를 담는다', () => {
  const line = outageLine(summary.outages[0])
  assert.match(line, /^\d{2}:\d{2}:\d{2}부터 3\.4초, 68건 실패/)
  assert.ok(line.includes('timeout 61'))
})

test('진행 중인 순단은 그렇게 표시한다', () => {
  const line = outageLine({ ...summary.outages[0], endTs: null, ongoing: true })
  assert.ok(line.includes('진행 중'))
})

test('베이스라인이 아직 끝나지 않았으면 "평소" 대신 측정 중이라고 보여준다', () => {
  // baseline.complete 가 false 인데 failureRate/p95 가 이미 null 이 아닌
  // 경우 — 측정 시작 직후 표본 몇 개로 계산된 값이다. 이걸 "평소"라고
  // 부르면 거짓 확신을 준다.
  const incomplete = {
    ...summary,
    baseline: { complete: false, sampleCount: 20, failureRate: 0, clientFailureRate: 0, p95: 80 },
  }
  const tiles = summaryTiles(incomplete)
  assert.equal(tiles.find((t) => t.label === '실패율').sub, '평소 측정 중')
  assert.equal(tiles.find((t) => t.label === 'p95 지연').sub, '평소 측정 중')
})

test('표본이 없어도 타일이 깨지지 않는다', () => {
  const empty = {
    ...summary,
    totals: { sent: 0, success: 0, failure: 0, byType: { network: 0, timeout: 0, server: 0, client: 0 }, slow: 0, dropped: 0 },
    percentiles: { p50: null, p95: null, p99: null, max: null, count: 0 },
    baseline: { complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null },
    outages: [], downtimeMs: 0,
  }
  const tiles = summaryTiles(empty)
  assert.equal(tiles.find((t) => t.label === '총 요청').value, '0')
  assert.equal(tiles.find((t) => t.label === 'p95 지연').value, '—')
})

test('경고 코드마다 설명 문구가 있다', () => {
  for (const code of ['dropped', 'baseline-unstable', 'client-heavy', 'unreachable']) {
    const msg = warningMessage(code)
    assert.ok(msg.title.length > 0, `${code} 의 제목이 없다`)
    assert.ok(msg.body.length > 0, `${code} 의 설명이 없다`)
  }
})

test('모르는 경고 코드는 코드를 그대로 보여준다', () => {
  assert.ok(warningMessage('처음보는코드').title.includes('처음보는코드'))
})
