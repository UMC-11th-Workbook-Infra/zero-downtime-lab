import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunStore } from '../src/run/run-store.js'

const fakeRun = (id, status = 'finished') => ({ id, status, startedAt: Date.now() })

test('넣은 실행을 id 로 꺼낸다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a'))
  assert.equal(store.get('a').id, 'a')
})

test('없는 id 는 undefined 다', () => {
  assert.equal(createRunStore({ max: 10 }).get('없음'), undefined)
})

test('최신순으로 나열한다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a')); store.add(fakeRun('b'))
  assert.deepEqual(store.list().map((r) => r.id), ['b', 'a'])
})

test('max 를 넘으면 오래된 것부터 버린다', () => {
  const store = createRunStore({ max: 3 })
  for (const id of ['a', 'b', 'c', 'd']) store.add(fakeRun(id))
  assert.deepEqual(store.list().map((r) => r.id), ['d', 'c', 'b'])
  assert.equal(store.get('a'), undefined)
})

test('running 상태인 실행을 active 로 찾는다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a', 'finished'))
  store.add(fakeRun('b', 'running'))
  assert.equal(store.active().id, 'b')
})

test('running 이 없으면 active 는 undefined 다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a', 'finished'))
  assert.equal(store.active(), undefined)
})
