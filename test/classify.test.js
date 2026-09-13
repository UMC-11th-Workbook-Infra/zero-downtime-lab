import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/prober/classify.js'

const OK = [200, 201]

test('성공 목록에 있는 상태코드는 성공이다', () => {
  assert.deepEqual(classify({ status: 201 }, OK), { outcome: 'success', failureType: null })
})

test('성공 목록에 409 를 넣으면 409 가 성공이 된다', () => {
  assert.deepEqual(classify({ status: 409 }, [200, 201, 409]), { outcome: 'success', failureType: null })
})

test('5xx 는 server 실패다', () => {
  assert.deepEqual(classify({ status: 503 }, OK), { outcome: 'failure', failureType: 'server' })
})

test('성공 목록 밖 4xx 는 client 실패다', () => {
  assert.deepEqual(classify({ status: 422 }, OK), { outcome: 'failure', failureType: 'client' })
})

test('3xx 는 따라가지 않고 client 실패로 분류된다', () => {
  assert.deepEqual(classify({ status: 302 }, OK), { outcome: 'failure', failureType: 'client' })
})

test('타임아웃은 timeout 실패다', () => {
  assert.deepEqual(classify({ timedOut: true }, OK), { outcome: 'failure', failureType: 'timeout' })
})

test('커넥션 거부는 network 실패다', () => {
  assert.deepEqual(classify({ errorCode: 'ECONNREFUSED' }, OK), { outcome: 'failure', failureType: 'network' })
})

test('DNS 실패는 network 실패다', () => {
  assert.deepEqual(classify({ errorCode: 'ENOTFOUND' }, OK), { outcome: 'failure', failureType: 'network' })
})

test('타임아웃 판정이 network 판정보다 우선한다', () => {
  // abort 로 끊긴 요청은 errorCode 도 같이 들고 오는 경우가 있다
  assert.deepEqual(
    classify({ timedOut: true, errorCode: 'ABORT_ERR' }, OK),
    { outcome: 'failure', failureType: 'timeout' },
  )
})
