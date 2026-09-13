import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutageDetector } from '../src/analysis/outage-detector.js'

let seq = 0
/** 테스트용 레코드를 간단히 만든다 */
function rec(ts, outcome, failureType = null) {
  seq += 1
  return { seq, ts, status: null, durationMs: null, outcome, failureType, error: null }
}
const ok = (ts) => rec(ts, 'success')
const fail = (ts, type = 'timeout') => rec(ts, 'failure', type)

test('연속 실패 2건은 순단이 아니다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  assert.equal(d.push(ok(1150)), null)
  assert.deepEqual(d.outages(), [])
})

test('연속 실패 3건은 순단이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  d.push(fail(1150))
  const outage = d.push(ok(1200))
  assert.ok(outage)
  assert.equal(outage.failureCount, 3)
  assert.equal(outage.ongoing, false)
})

test('지속 시간은 직전 성공부터 다음 성공까지로 잰다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  d.push(fail(1150))
  const outage = d.push(ok(4000))
  // 실패 구간(1050~1150)이 아니라 성공과 성공 사이(1000~4000)를 잰다
  assert.equal(outage.startTs, 1000)
  assert.equal(outage.endTs, 4000)
  assert.equal(outage.durationMs, 3000)
})

test('실패 유형별로 건수를 센다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050, 'timeout'))
  d.push(fail(1100, 'timeout'))
  d.push(fail(1150, 'network'))
  const outage = d.push(ok(1200))
  assert.deepEqual(outage.byType, { network: 1, timeout: 2, server: 0, client: 0 })
})

test('순단이 두 번이면 둘로 분리된다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050)); d.push(fail(1100)); d.push(fail(1150))
  d.push(ok(1200))
  d.push(fail(2050)); d.push(fail(2100)); d.push(fail(2150))
  d.push(ok(2200))
  assert.equal(d.outages().length, 2)
  assert.equal(d.outages()[0].startTs, 1000)
  assert.equal(d.outages()[1].startTs, 1200)
})

test('한 번도 성공한 적이 없으면 순단으로 치지 않는다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(fail(1000, 'network'))
  d.push(fail(1050, 'network'))
  d.push(fail(1100, 'network'))
  assert.equal(d.push(ok(1150)), null)
  assert.deepEqual(d.outages(), [])
})

test('복구되지 않은 순단은 finish 에서 ongoing 으로 나온다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050)); d.push(fail(1100)); d.push(fail(1150))
  const outage = d.finish()
  assert.ok(outage)
  assert.equal(outage.ongoing, true)
  assert.equal(outage.endTs, null)
  assert.equal(outage.durationMs, 150) // 1000 -> 마지막 실패 1150
  assert.equal(d.outages().length, 1)
})

test('finish 시점에 진행 중인 순단이 없으면 null 이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  assert.equal(d.finish(), null)
})

test('minConsecutiveFailures 를 1 로 두면 단발 실패도 순단이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 1 })
  d.push(ok(1000))
  d.push(fail(1050))
  assert.ok(d.push(ok(1100)))
})
