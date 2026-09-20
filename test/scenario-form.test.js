import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headersFromText, headersToText, statusCodesFromText, buildScenario } from '../public/lib/scenario-form.js'

test('헤더 텍스트를 객체로 바꾼다', () => {
  assert.deepEqual(
    headersFromText('Content-Type: application/json\nAuthorization: Bearer abc'),
    { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
  )
})

test('빈 줄과 공백을 무시한다', () => {
  assert.deepEqual(headersFromText('\n  Content-Type:  application/json  \n\n'), { 'Content-Type': 'application/json' })
})

test('값에 콜론이 있어도 첫 콜론에서만 자른다', () => {
  assert.deepEqual(headersFromText('X-Url: https://a.dev/b'), { 'X-Url': 'https://a.dev/b' })
})

test('콜론이 없는 줄은 버린다', () => {
  assert.deepEqual(headersFromText('이건헤더가아님'), {})
})

test('헤더 객체를 텍스트로 되돌린다', () => {
  assert.equal(headersToText({ A: '1', B: '2' }), 'A: 1\nB: 2')
})

test('상태코드 텍스트를 숫자 배열로 바꾼다', () => {
  assert.deepEqual(statusCodesFromText('200, 201'), [200, 201])
  assert.deepEqual(statusCodesFromText('200,201 , 409'), [200, 201, 409])
})

test('상태코드에서 숫자가 아닌 항목은 버린다', () => {
  assert.deepEqual(statusCodesFromText('200, 이백일, 201'), [200, 201])
})

test('폼 값으로 시나리오를 만든다', () => {
  const scenario = buildScenario({
    name: '회원가입',
    url: 'https://api.example.com/signup',
    method: 'POST',
    headersText: 'Content-Type: application/json',
    body: '{"email":"lab-{{uuid}}@test.local"}',
    statusCodesText: '200, 201',
    rps: '20',
    durationSec: '300',
    timeoutMs: '5000',
    slowThresholdMs: '1000',
    baselineSec: '30',
    minConsecutiveFailures: '3',
  })

  assert.equal(scenario.target.url, 'https://api.example.com/signup')
  assert.deepEqual(scenario.success.statusCodes, [200, 201])
  assert.equal(scenario.load.rps, 20)
  assert.equal(scenario.analysis.baselineSec, 30)
  assert.equal(typeof scenario.load.durationSec, 'number')
})
