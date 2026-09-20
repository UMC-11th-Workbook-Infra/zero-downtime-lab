import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/api/routes.js'
import { createRunStore } from '../src/run/run-store.js'

const T0 = 1_700_000_000_000
const rec = (seq, offsetMs, outcome, failureType = null) => ({
  seq, ts: T0 + offsetMs, status: outcome === 'success' ? 200 : 500,
  durationMs: outcome === 'success' ? 50 : null, outcome, failureType, error: null,
})

/** 정해둔 레코드를 흘려보내고 끝나는 가짜 프로버 */
function fakeProberFactory(records) {
  return () => ({
    async start(scenario, onRecord) {
      for (const r of records) onRecord(r)
      return { fired: records.length, dropped: 0 }
    },
    stop() {},
  })
}

/**
 * 레코드를 실제로 비동기 경계를 두고 하나씩, 테스트가 직접 통제해 전달하는
 * 가짜 프로버.
 *
 * 위의 fakeProberFactory 는 모든 레코드를 동기적으로 쏟아내서 POST
 * /api/runs 가 응답을 돌려주기도 전에 실행이 이미 finished 가 돼 버린다.
 * 그래서 라이브 SSE 구독, bucket id 증가, 종료 핸들러, 409 가드처럼
 * "아직 실행 중인 동안" 만 거치는 경로가 지금까지 테스트를 한 번도
 * 타지 않았다 — 바로 FIX 1의 버그가 숨어 있던 자리다.
 *
 * start() 는 test 가 stop() 을 부르기 전까지 끝나지 않는다. 레코드는
 * control.deliver() 로 하나씩 넘기고, 그때마다 실제 프로버처럼 최소
 * 하나의 매크로태스크 경계(setTimeout(0))를 사이에 둔다.
 */
function controlledProberFactory() {
  const controls = []
  const factory = () => {
    let onRecord = null
    let resolveDone = null
    let stopped = false

    const control = {
      async deliver(record) {
        onRecord(record)
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      stop() {
        if (stopped) return
        stopped = true
        resolveDone({ fired: 0, dropped: 0 })
      },
    }
    controls.push(control)

    return {
      async start(scenario, cb) {
        onRecord = cb
        return new Promise((resolve) => { resolveDone = resolve })
      },
      stop() { control.stop() },
    }
  }
  return { factory, controls }
}

/** SSE 원문을 이벤트 배열로 파싱한다 (하트비트 주석은 걸러낸다) */
function parseSseEvents(text) {
  return text.split('\n\n')
    .map((block) => {
      const eventMatch = block.match(/^event: (.+)$/m)
      const dataMatch = block.match(/^data: (.+)$/m)
      if (!eventMatch || !dataMatch) return null
      return { event: eventMatch[1], data: JSON.parse(dataMatch[1]) }
    })
    .filter((e) => e !== null)
}

async function listen(app) {
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const DEFAULT_RECORDS = [
  rec(1, 0, 'success'),
  rec(2, 1200, 'success'),
  rec(3, 2400, 'success'),
]

function appWith(records = DEFAULT_RECORDS) {
  return createApp({ store: createRunStore({ max: 10 }), proberFactory: fakeProberFactory(records) })
}

// baselineSec 을 명시한다. 기본값 30 은 durationSec 10 보다 크므로
// 교차 검사(baselineSec < durationSec)에 걸려 400 이 된다.
const body = {
  target: { url: 'https://api.example.com/signup' },
  load: { durationSec: 10 },
  analysis: { baselineSec: 5 },
}

test('GET /api/defaults 는 폼 기본값을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const out = await (await fetch(`${base}/api/defaults`)).json()
    assert.equal(out.load.rps, 20)
    assert.deepEqual(out.success.statusCodes, [200, 201])
  } finally { close() }
})

test('POST /api/runs 는 runId 를 돌려준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 201)
    assert.match((await res.json()).runId, /^[0-9a-f-]{36}$/)
  } finally { close() }
})

test('검증에 실패하면 400 과 오류 목록을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { url: '' } }),
    })
    assert.equal(res.status, 400)
    assert.ok((await res.json()).errors.length > 0)
  } finally { close() }
})

test('GET /api/runs/:id 는 요약을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const summary = await (await fetch(`${base}/api/runs/${runId}`)).json()
    assert.equal(summary.runId, runId)
    assert.equal(summary.totals.sent, 3)
  } finally { close() }
})

test('없는 실행은 404 다', async () => {
  const { base, close } = await listen(appWith())
  try {
    assert.equal((await fetch(`${base}/api/runs/없음`)).status, 404)
  } finally { close() }
})

test('GET /api/runs 는 최근 실행 목록을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const list = await (await fetch(`${base}/api/runs`)).json()
    assert.equal(list.length, 1)
    assert.ok('status' in list[0])
  } finally { close() }
})

test('SSE 로 연결하면 지금까지의 버킷과 요약을 받는다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const res = await fetch(`${base}/api/runs/${runId}/stream`)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')

    const text = await readUntilClose(res)
    assert.ok(text.includes('event: bucket'), '버킷 이벤트가 있어야 한다')
    assert.ok(text.includes('event: summary'), '요약 이벤트가 있어야 한다')
    assert.ok(/^id: \d+$/m.test(text), '버킷에 id 가 붙어야 한다')
  } finally { close() }
})

test('Last-Event-ID 이후의 버킷만 다시 보낸다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const all = await readUntilClose(await fetch(`${base}/api/runs/${runId}/stream`))
    const resumed = await readUntilClose(await fetch(`${base}/api/runs/${runId}/stream`, {
      headers: { 'Last-Event-ID': '1' },
    }))

    const count = (t) => (t.match(/event: bucket/g) ?? []).length
    assert.ok(count(resumed) < count(all), '이미 받은 버킷은 다시 보내지 않아야 한다')
  } finally { close() }
})

test('중지 시점에 진행 중이던 순단이 라이브 SSE 로 전달되고 최종 요약에도 반영된다', async () => {
  const { factory, controls } = controlledProberFactory()
  const { base, close } = await listen(createApp({ store: createRunStore({ max: 10 }), proberFactory: factory }))
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, analysis: { baselineSec: 5, minConsecutiveFailures: 2 } }),
    })).json()

    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`)
    const textPromise = readUntilClose(streamRes)

    const control = controls[0]
    await control.deliver(rec(1, 0, 'success'))
    await control.deliver(rec(2, 100, 'failure', 'timeout'))
    await control.deliver(rec(3, 150, 'failure', 'timeout'))
    // 순단이 복구되기 전에 중지한다 — 서버는 ongoing 순단을 들고 있어야 한다
    await fetch(`${base}/api/runs/${runId}/stop`, { method: 'POST' })

    const text = await textPromise
    const events = parseSseEvents(text)

    const outageEvents = events.filter((e) => e.event === 'outage')
    assert.equal(outageEvents.length, 1, '진행 중이던 순단이 라이브로 한 번 전달돼야 한다')

    const summaryEvents = events.filter((e) => e.event === 'summary')
    const clientSummary = summaryEvents[summaryEvents.length - 1].data

    const serverSummary = await (await fetch(`${base}/api/runs/${runId}`)).json()

    assert.equal(clientSummary.outages.length, 1)
    assert.equal(clientSummary.outages.length, serverSummary.outages.length,
      `클라이언트가 본 순단(${clientSummary.outages.length})과 서버 최종 순단(${serverSummary.outages.length})이 달라선 안 된다`)
    assert.equal(clientSummary.downtimeMs, serverSummary.downtimeMs)
    assert.equal(clientSummary.status, 'stopped')
  } finally { close() }
})

test('최종 요약은 종료 state 보다 wire 상에서 먼저 온다', async () => {
  const { factory, controls } = controlledProberFactory()
  const { base, close } = await listen(createApp({ store: createRunStore({ max: 10 }), proberFactory: factory }))
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const streamRes = await fetch(`${base}/api/runs/${runId}/stream`)
    const textPromise = readUntilClose(streamRes)

    const control = controls[0]
    await control.deliver(rec(1, 0, 'success'))
    control.stop()

    const events = parseSseEvents(await textPromise)
    const lastSummaryIndex = events.map((e) => e.event).lastIndexOf('summary')
    const lastStateIndex = events.map((e) => e.event).lastIndexOf('state')

    assert.ok(lastSummaryIndex >= 0 && lastStateIndex >= 0, '요약과 state 이벤트가 모두 있어야 한다')
    assert.ok(lastSummaryIndex < lastStateIndex,
      `요약(index ${lastSummaryIndex})이 종료 state(index ${lastStateIndex})보다 먼저 와야 한다`)
    assert.notEqual(events[lastStateIndex].data.status, 'running')
  } finally { close() }
})

test('실행 중일 때 두 번째 POST /api/runs 는 409 를 돌려준다', async () => {
  const { factory, controls } = controlledProberFactory()
  const { base, close } = await listen(createApp({ store: createRunStore({ max: 10 }), proberFactory: factory }))
  try {
    const first = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(first.status, 201)

    // 첫 실행은 레코드를 하나도 못 받은 채로 여전히 running 이다 —
    // 이전엔(모든 레코드를 동기로 쏟아내는 가짜 프로버만 있어서) 이 경로가
    // 한 번도 테스트되지 않았다.
    const second = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(second.status, 409)
    assert.ok((await second.json()).errors[0].includes('이미 실행 중'))

    // 정리: 실행을 끝내지 않으면 summaryTimer(setInterval)가 남아 프로세스가 안 끝난다
    controls[0].stop()
    await new Promise((r) => setTimeout(r, 10))
  } finally { close() }
})

/** 스트림이 닫힐 때까지 전부 읽는다 */
async function readUntilClose(res) {
  let text = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}
