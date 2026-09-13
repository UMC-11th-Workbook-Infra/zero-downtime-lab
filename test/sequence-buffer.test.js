import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSequenceBuffer } from '../src/prober/sequence-buffer.js'

const r = (seq) => ({ seq, ts: 1000 + seq, outcome: 'success', failureType: null, status: 200, durationMs: 10, error: null })
const seqs = (records) => records.map((x) => x.seq)

test('순서대로 들어오면 즉시 나온다', () => {
  const b = createSequenceBuffer({})
  assert.deepEqual(seqs(b.push(r(1))), [1])
  assert.deepEqual(seqs(b.push(r(2))), [2])
})

test('앞선 레코드가 아직 안 왔으면 붙잡고 있는다', () => {
  const b = createSequenceBuffer({})
  assert.deepEqual(b.push(r(3)), [])
  assert.deepEqual(b.push(r(2)), [])
  assert.equal(b.pending(), 2)
})

test('빠진 레코드가 도착하면 밀려 있던 것이 한꺼번에 나온다', () => {
  const b = createSequenceBuffer({})
  b.push(r(3))
  b.push(r(2))
  assert.deepEqual(seqs(b.push(r(1))), [1, 2, 3])
  assert.equal(b.pending(), 0)
})

test('배포 중 뒤집힌 완료 순서를 발사 순서로 되돌린다', () => {
  const b = createSequenceBuffer({})
  const out = []
  // C(성공)가 A, B(타임아웃)보다 먼저 완료된 상황
  out.push(...b.push({ ...r(3), outcome: 'success' }))
  out.push(...b.push({ ...r(1), outcome: 'failure', failureType: 'timeout' }))
  out.push(...b.push({ ...r(2), outcome: 'failure', failureType: 'timeout' }))
  assert.deepEqual(seqs(out), [1, 2, 3])
  assert.deepEqual(out.map((x) => x.outcome), ['failure', 'failure', 'success'])
})

test('flush 는 구멍이 있어도 남은 것을 순서대로 낸다', () => {
  const b = createSequenceBuffer({})
  b.push(r(2))
  b.push(r(5))
  b.push(r(4))
  assert.deepEqual(seqs(b.flush()), [2, 4, 5])
  assert.equal(b.pending(), 0)
})

test('flush 이후에도 계속 쓸 수 있다', () => {
  const b = createSequenceBuffer({})
  b.push(r(2))
  b.flush()
  assert.deepEqual(seqs(b.push(r(6))), [6])
})

test('firstSeq 를 지정할 수 있다', () => {
  const b = createSequenceBuffer({ firstSeq: 10 })
  assert.deepEqual(b.push(r(11)), [])
  assert.deepEqual(seqs(b.push(r(10))), [10, 11])
})
