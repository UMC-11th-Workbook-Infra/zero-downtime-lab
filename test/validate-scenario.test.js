import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateScenario, DEFAULTS } from '../src/api/validate-scenario.js'

const minimal = { target: { url: 'https://api.example.com/signup' } }

test('url 만 주면 나머지는 기본값으로 채워진다', () => {
  const out = validateScenario(minimal)
  assert.equal(out.ok, true)
  assert.equal(out.scenario.target.method, 'POST')
  assert.equal(out.scenario.target.timeoutMs, 5000)
  assert.deepEqual(out.scenario.success.statusCodes, [200, 201])
  assert.equal(out.scenario.load.rps, 20)
  assert.equal(out.scenario.load.durationSec, 300)
  assert.equal(out.scenario.analysis.minConsecutiveFailures, 3)
})

test('url 이 없으면 거절한다', () => {
  const out = validateScenario({ target: {} })
  assert.equal(out.ok, false)
  assert.ok(out.errors.some((e) => e.includes('주소')))
})

test('http/https 가 아닌 스킴은 거절한다', () => {
  assert.equal(validateScenario({ target: { url: 'ftp://x/y' } }).ok, false)
  assert.equal(validateScenario({ target: { url: '그냥문자열' } }).ok, false)
})

test('지원하지 않는 메서드는 거절한다', () => {
  const out = validateScenario({ target: { ...minimal.target, method: 'TRACE' } })
  assert.equal(out.ok, false)
})

test('메서드는 대소문자를 가리지 않고 대문자로 정규화한다', () => {
  assert.equal(validateScenario({ target: { ...minimal.target, method: 'post' } }).scenario.target.method, 'POST')
})

test('rps 범위를 벗어나면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, load: { rps: 0 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, load: { rps: 500 } }).ok, false)
})

test('성공 상태코드가 비어 있으면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [] } }).ok, false)
})

test('성공 상태코드에 숫자가 아닌 값이 있으면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [200, '이백일'] } }).ok, false)
})

test('베이스라인이 실행 시간보다 길면 거절한다', () => {
  const out = validateScenario({ ...minimal, load: { durationSec: 20 }, analysis: { baselineSec: 30 } })
  assert.equal(out.ok, false)
  assert.ok(out.errors.some((e) => e.includes('베이스라인')))
})

test('헤더 값이 문자열이 아니면 거절한다', () => {
  assert.equal(validateScenario({ target: { ...minimal.target, headers: { 'X-N': 5 } } }).ok, false)
})

test('오류가 여럿이면 전부 모아서 돌려준다', () => {
  const out = validateScenario({ target: { url: 'nope' }, load: { rps: 9999 } })
  assert.equal(out.ok, false)
  assert.ok(out.errors.length >= 2)
})

test('DEFAULTS 는 그대로 검증을 통과한다', () => {
  assert.equal(validateScenario({ ...DEFAULTS, target: { ...DEFAULTS.target, url: 'https://x.dev/s' } }).ok, true)
})
