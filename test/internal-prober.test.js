import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createProber } from '../src/prober/index.js'

/** 핸들러를 바꿔 끼울 수 있는 테스트 서버를 띄운다 */
async function startServer(handler) {
  const state = { handler }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => state.handler(req, res, body))
  })
  server.listen(0)
  await new Promise((r) => server.once('listening', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/signup`,
    setHandler: (h) => { state.handler = h },
    close: () => new Promise((r) => server.close(r)),
  }
}

function scenarioFor(url, overrides = {}) {
  return {
    name: '테스트',
    target: {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local","nickname":"u{{counter}}"}',
      timeoutMs: 1000,
      ...overrides.target,
    },
    success: { statusCodes: [200, 201] },
    load: { rps: 20, durationSec: 1, ...overrides.load },
    analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
  }
}

test('성공 응답을 성공 레코드로 만든다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const records = []
    const prober = createProber('internal')
    const stats = await prober.start(scenarioFor(server.url), (r) => records.push(r))

    assert.ok(records.length >= 10, `레코드 ${records.length}건은 너무 적다`)
    assert.ok(records.every((r) => r.outcome === 'success'))
    assert.ok(records.every((r) => r.status === 201))
    assert.ok(records.every((r) => typeof r.durationMs === 'number'))
    assert.equal(stats.dropped, 0)
  } finally {
    await server.close()
  }
})

test('레코드는 발사 순서대로 전달된다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const records = []
    await createProber('internal').start(scenarioFor(server.url), (r) => records.push(r))
    assert.deepEqual(records.map((r) => r.seq), records.map((_, i) => i + 1))
  } finally {
    await server.close()
  }
})

test('플레이스홀더가 요청마다 다른 값으로 치환된다', async () => {
  const seen = []
  const server = await startServer((req, res, body) => {
    seen.push(JSON.parse(body))
    res.writeHead(201); res.end('{}')
  })
  try {
    await createProber('internal').start(scenarioFor(server.url), () => {})
    const emails = new Set(seen.map((b) => b.email))
    assert.equal(emails.size, seen.length, '이메일이 중복되면 안 된다')
    assert.equal(seen[0].nickname, 'u1')
  } finally {
    await server.close()
  }
})

test('5xx 는 server 실패로 기록된다', async () => {
  const server = await startServer((req, res) => { res.writeHead(503); res.end('') })
  try {
    const records = []
    await createProber('internal').start(scenarioFor(server.url), (r) => records.push(r))
    assert.ok(records.every((r) => r.failureType === 'server'))
  } finally {
    await server.close()
  }
})

test('응답하지 않는 서버는 timeout 실패가 되고 durationMs 는 null 이다', async () => {
  const server = await startServer(() => { /* 영원히 응답하지 않는다 */ })
  try {
    const records = []
    const s = scenarioFor(server.url, { target: { timeoutMs: 200 }, load: { rps: 10, durationSec: 1 } })
    await createProber('internal').start(s, (r) => records.push(r))
    assert.ok(records.length > 0)
    assert.ok(records.every((r) => r.failureType === 'timeout'))
    assert.ok(records.every((r) => r.durationMs === null))
  } finally {
    await server.close()
  }
})

test('redirect: manual 이라 302 는 따라가지 않고 client 실패로 기록된다', async () => {
  // 배포가 유지보수 페이지로 리다이렉트되는 경우를 흉내낸다. 리다이렉트를
  // 따라가면 최종적으로 200 을 받아 "성공"으로 잘못 기록된다 — 배포가
  // 깨졌는데 "이상 없음"이라고 말하는 조용한 거짓말이다. internal-prober.js
  // 의 redirect: 'manual' 이 이걸 막는다: 302 자체를 판정 대상으로 삼아야
  // client 실패가 된다.
  const server = await startServer((req, res) => {
    if (req.url === '/signup') {
      res.writeHead(302, { Location: '/maintenance' })
      res.end()
    } else {
      res.writeHead(200)
      res.end('ok')
    }
  })
  try {
    const records = []
    await createProber('internal').start(scenarioFor(server.url), (r) => records.push(r))
    assert.ok(records.length > 0)
    assert.ok(records.every((r) => r.outcome === 'failure'), '302 를 성공으로 기록하면 안 된다')
    assert.ok(records.every((r) => r.failureType === 'client'))
    assert.ok(records.every((r) => r.status === 302))
  } finally {
    await server.close()
  }
})

test('닿지 않는 주소는 network 실패가 된다', async () => {
  const records = []
  // 127.0.0.1 의 닫힌 포트 -> ECONNREFUSED
  const s = scenarioFor('http://127.0.0.1:9/signup', { load: { rps: 10, durationSec: 1 } })
  await createProber('internal').start(s, (r) => records.push(r))
  assert.ok(records.length > 0)
  assert.ok(records.every((r) => r.failureType === 'network'))
})

test('stop 을 부르면 일찍 끝난다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const prober = createProber('internal')
    const started = Date.now()
    const promise = prober.start(scenarioFor(server.url, { load: { rps: 20, durationSec: 60 } }), () => {})
    setTimeout(() => prober.stop(), 300)
    await promise
    assert.ok(Date.now() - started < 3000, '60초를 기다리면 안 된다')
  } finally {
    await server.close()
  }
})

test('알 수 없는 프로버 종류는 예외를 던진다', () => {
  assert.throws(() => createProber('k6'), /알 수 없는 프로버/)
})
