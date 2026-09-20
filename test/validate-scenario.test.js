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

// 경계값 테스트: rps
test('rps 경계: 1과 200은 수락, 0과 201은 거절', () => {
  assert.equal(validateScenario({ ...minimal, load: { rps: 1 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, load: { rps: 200 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, load: { rps: 0 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, load: { rps: 201 } }).ok, false)
})

// 경계값 테스트: durationSec
// 주의: 범위 오류와 교차 필드(베이스라인) 오류가 둘 다 '실행 시간'이라는 문구를
// 포함할 수 있으므로, 부분 문자열 매칭만으로는 어느 검사가 실패를 만들었는지
// 구분할 수 없다. 여기서는 오류가 정확히 1개이고 그 내용이 범위 오류 메시지와
// 정확히 일치하며 '베이스라인'을 전혀 언급하지 않는지까지 확인해서
// durationSec 자체의 경계가 검사되고 있음을 못박는다.
test('durationSec 범위: 실행 시간의 최소 유효값 6과 최대값 3600', () => {
  // durationSec: 4는 범위 미만 - 자체 범위 오류만 발생해야 한다 (교차 필드 오류 없음)
  const below = validateScenario({ ...minimal, load: { durationSec: 4 }, analysis: { baselineSec: 5 } })
  assert.equal(below.ok, false)
  assert.equal(below.errors.length, 1)
  assert.equal(below.errors[0], '실행 시간은(는) 5 이상 3600 이하여야 합니다. (받은 값: 4)')
  assert.ok(!below.errors.some((e) => e.includes('베이스라인')))

  // durationSec: 6, baselineSec: 5는 최소 유효값 (baselineSec의 자체 최솟값 5가
  // durationSec보다 작아야 하므로 durationSec의 실제 최소 유효값은 6이다)
  const minValid = validateScenario({ ...minimal, load: { durationSec: 6 }, analysis: { baselineSec: 5 } })
  assert.equal(minValid.ok, true)

  // durationSec: 3600은 최대값
  const max = validateScenario({ ...minimal, load: { durationSec: 3600 } })
  assert.equal(max.ok, true)

  // durationSec: 3601은 범위 초과 - 자체 범위 오류만 발생해야 한다 (교차 필드 오류 없음)
  const above = validateScenario({ ...minimal, load: { durationSec: 3601 }, analysis: { baselineSec: 30 } })
  assert.equal(above.ok, false)
  assert.equal(above.errors.length, 1)
  assert.equal(above.errors[0], '실행 시간은(는) 5 이상 3600 이하여야 합니다. (받은 값: 3601)')
  assert.ok(!above.errors.some((e) => e.includes('베이스라인')))
})

// 경계값 테스트: timeoutMs
test('timeoutMs 경계: 100과 60000은 수락, 99와 60001은 거절', () => {
  assert.equal(validateScenario({ target: { ...minimal.target, timeoutMs: 100 } }).ok, true)
  assert.equal(validateScenario({ target: { ...minimal.target, timeoutMs: 60000 } }).ok, true)
  assert.equal(validateScenario({ target: { ...minimal.target, timeoutMs: 99 } }).ok, false)
  assert.equal(validateScenario({ target: { ...minimal.target, timeoutMs: 60001 } }).ok, false)
})

// 경계값 테스트: slowThresholdMs
test('slowThresholdMs 경계: 1과 60000은 수락, 0과 60001은 거절', () => {
  assert.equal(validateScenario({ ...minimal, analysis: { slowThresholdMs: 1 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, analysis: { slowThresholdMs: 60000 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, analysis: { slowThresholdMs: 0 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, analysis: { slowThresholdMs: 60001 } }).ok, false)
})

// 경계값 테스트: minConsecutiveFailures
test('minConsecutiveFailures 경계: 1과 100은 수락, 0과 101은 거절', () => {
  assert.equal(validateScenario({ ...minimal, analysis: { minConsecutiveFailures: 1 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, analysis: { minConsecutiveFailures: 100 } }).ok, true)
  assert.equal(validateScenario({ ...minimal, analysis: { minConsecutiveFailures: 0 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, analysis: { minConsecutiveFailures: 101 } }).ok, false)
})

// 경계값 테스트: statusCodes
test('statusCodes 경계: 100과 599는 수락, 99와 600은 거절', () => {
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [100] } }).ok, true)
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [599] } }).ok, true)
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [99] } }).ok, false)
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [600] } }).ok, false)
})

// 경계값 테스트: baselineSec vs durationSec
test('baselineSec 경계: duration과 같으면 거절, 한 칸 작으면 수락', () => {
  assert.equal(validateScenario({ ...minimal, load: { durationSec: 100 }, analysis: { baselineSec: 100 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, load: { durationSec: 100 }, analysis: { baselineSec: 99 } }).ok, true)
})

// 교차 필드 검증: 범위 오류가 있으면 교차 필드 검사를 건너뛴다
test('baselineSec이 범위를 벗어나면 교차 필드 검사를 수행하지 않는다', () => {
  const out = validateScenario({ ...minimal, load: { durationSec: 20 }, analysis: { baselineSec: 1 } })
  assert.equal(out.ok, false)
  assert.equal(out.errors.length, 1)
  assert.ok(out.errors[0].includes('베이스라인 구간'))
  assert.ok(out.errors[0].includes('5 이상'))
})

// 교차 필드 검증: 두 필드가 모두 유효하면 교차 필드 검사를 수행한다
test('두 필드가 모두 범위 내이면 교차 필드 검사를 수행한다', () => {
  const out = validateScenario({ ...minimal, load: { durationSec: 20 }, analysis: { baselineSec: 30 } })
  assert.equal(out.ok, false)
  assert.equal(out.errors.length, 1)
  assert.ok(out.errors[0].includes('베이스라인 구간'))
  assert.ok(out.errors[0].includes('실행 시간'))
})
