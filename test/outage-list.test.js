import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutageList } from '../public/lib/outage-list.js'

const outageA = { startTs: 1000, endTs: 1500, durationMs: 500, failureCount: 3, byType: {}, ongoing: false }
const outageB = { startTs: 2000, endTs: 2500, durationMs: 500, failureCount: 2, byType: {}, ongoing: false }

test('처음 보는 순단을 추가하면 true를 돌려준다', () => {
  const list = createOutageList()
  assert.equal(list.add(outageA), true)
  assert.deepEqual(list.all(), [outageA])
})

test('시작 시각이 같은 순단은 추가되지 않는다', () => {
  const list = createOutageList()
  list.add(outageA)
  assert.equal(list.add({ ...outageA }), false)
  assert.equal(list.all().length, 1)
})

test('SSE 재연결로 기존 순단들이 다시 오면 전부 무시한다', () => {
  const list = createOutageList()
  list.add(outageA)
  list.add(outageB)
  // 재연결: 서버가 스트림을 다시 열면서 같은 두 순단을 다시 보낸다
  list.add({ ...outageA })
  list.add({ ...outageB })
  assert.deepEqual(list.all().map((o) => o.startTs), [1000, 2000])
})

test('takeUnrendered 는 새로 추가된 순단만 돌려준다', () => {
  const list = createOutageList()
  list.add(outageA)
  assert.deepEqual(list.takeUnrendered(), [outageA])
  // 아직 새로 추가된 게 없으면 빈 배열
  assert.deepEqual(list.takeUnrendered(), [])
  list.add(outageB)
  assert.deepEqual(list.takeUnrendered(), [outageB])
})

test('비어있는지 여부를 올바르게 알려준다', () => {
  const list = createOutageList()
  assert.equal(list.isEmpty(), true)
  list.add(outageA)
  assert.equal(list.isEmpty(), false)
})

test('reset 하면 목록과 렌더 위치가 함께 비워진다 (두 번째 실행 시작)', () => {
  const list = createOutageList()
  list.add(outageA)
  list.add(outageB)
  list.takeUnrendered()
  list.reset()

  assert.equal(list.isEmpty(), true)

  // 두 번째 실행의 첫 순단 — 리셋 직후이므로 정상적으로 추가되고 그려져야 한다
  const secondRunOutage = { startTs: 5000, endTs: 5200, durationMs: 200, failureCount: 1, byType: {}, ongoing: false }
  assert.equal(list.add(secondRunOutage), true)
  assert.deepEqual(list.takeUnrendered(), [secondRunOutage])
})

test('reset 이후에는 이전 실행과 같은 시작 시각도 다시 추가할 수 있다', () => {
  const list = createOutageList()
  list.add(outageA)
  list.reset()
  assert.equal(list.add({ ...outageA }), true)
  assert.equal(list.all().length, 1)
})
