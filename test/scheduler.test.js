import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/prober/scheduler.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 영원히 끝나지 않는 요청 — 대상이 죽어 응답이 없는 상황을 흉내낸다 */
const never = () => new Promise(() => {})

test('응답이 오지 않아도 발사 간격이 유지된다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(never)
  await sleep(200)
  s.stop()
  // 200ms / 10ms = 20슬롯. 타이머 오차를 감안해 넉넉히 잡는다.
  assert.ok(s.stats().fired >= 12, `발사 ${s.stats().fired}건은 너무 적다`)
  assert.equal(s.stats().dropped, 0)
})

test('in-flight 상한에 걸리면 dropped 가 올라간다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 3 })
  s.start(never)
  await sleep(200)
  s.stop()
  assert.equal(s.stats().fired, 3, 'in-flight 상한까지만 발사해야 한다')
  assert.ok(s.stats().dropped > 0, '나머지 슬롯은 dropped 로 세야 한다')
})

test('요청이 끝나면 in-flight 가 줄어 다시 발사된다', async () => {
  let resolvers = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 2 })
  s.start(() => new Promise((resolve) => resolvers.push(resolve)))
  await sleep(60)
  assert.equal(s.stats().fired, 2)

  resolvers.forEach((r) => r())
  resolvers = []
  await sleep(60)
  s.stop()
  assert.ok(s.stats().fired > 2, '완료 후에는 다시 발사돼야 한다')
})

test('seq 는 1부터 순서대로 붙는다', async () => {
  const seen = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async (seq) => { seen.push(seq) })
  await sleep(80)
  s.stop()
  assert.equal(seen[0], 1)
  assert.deepEqual(seen, seen.map((_, i) => i + 1))
})

test('버린 슬롯은 seq 를 소비하지 않는다', async () => {
  const seen = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 2 })
  s.start(async (seq) => { seen.push(seq); await never() })
  await sleep(150)
  s.stop()
  // dropped 가 많아도 실제 발사된 두 건의 seq 는 1, 2 여야 한다
  assert.deepEqual(seen, [1, 2])
  assert.ok(s.stats().dropped > 0)
})

test('stop 이후에는 더 발사하지 않는다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async () => {})
  await sleep(50)
  s.stop()
  const after = s.stats().fired
  await sleep(60)
  assert.equal(s.stats().fired, after)
})

test('onFire 가 예외를 던져도 스케줄러는 계속 돈다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async () => { throw new Error('boom') })
  await sleep(80)
  s.stop()
  assert.ok(s.stats().fired >= 3)
  assert.equal(s.stats().inFlight, 0, '예외가 나도 in-flight 는 해제돼야 한다')
})

test('이벤트 루프 지연으로 인해 놓친 슬롯은 dropped로 센다', async () => {
  const seen = []
  let isFirst = true
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })

  s.start(async (seq) => {
    seen.push(seq)

    // 첫 요청에서 이벤트 루프를 블로킹한다 (120ms 정도)
    if (isFirst) {
      isFirst = false
      const end = Date.now() + 120
      while (Date.now() < end) {
        // 바쁜 대기
      }
    }
  })

  await sleep(300)
  s.stop()

  // 이벤트 루프 지연으로 인해 dropped가 올라간다
  assert.ok(s.stats().dropped >= 5, `dropped ${s.stats().dropped}는 너무 적다`)

  // 발사된 seq는 1부터 연속이다 (구멍이 없다)
  assert.deepEqual(seen, seen.map((_, i) => i + 1))

  // 발사된 요청 수는 stats().fired와 같다
  assert.equal(seen.length, s.stats().fired)
})
