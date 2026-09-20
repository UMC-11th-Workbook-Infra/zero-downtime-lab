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
