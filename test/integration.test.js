import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRun } from '../src/run/run.js'
import { createProber } from '../src/prober/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 201을 돌려주는 서버를 지정한 포트에 띄운다 */
async function startServer(port = 0) {
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.listen(port)
  await new Promise((r) => server.once('listening', r))
  return server
}

/** 소켓까지 전부 끊어 새 연결이 거부되게 만든다 (컨테이너가 죽은 상황) */
async function killServer(server) {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}

test('배포 중 3초 끊기면 순단 1건으로 잡힌다', async (t) => {
  t.diagnostic('서버를 띄우고 → 2초 뒤 죽이고 → 3초 뒤 되살린다')

  let server = await startServer()
  const port = server.address().port

  const scenario = {
    name: '통합 테스트',
    target: {
      url: `http://127.0.0.1:${port}/signup`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local"}',
      timeoutMs: 400,
    },
    success: { statusCodes: [201] },
    load: { rps: 20, durationSec: 8 },
    analysis: { slowThresholdMs: 1000, baselineSec: 5, minConsecutiveFailures: 3 },
  }

  const run = createRun({ scenario, prober: createProber('internal') })
  const started = Date.now()

  // 2초 뒤 죽이고, 그로부터 3초 뒤 같은 포트에 되살린다
  const outageScript = (async () => {
    await sleep(2000)
    await killServer(server)
    await sleep(3000)
    server = await startServer(port)
  })()

  await run.start()
  await outageScript
  await killServer(server)

  const summary = run.summary()
  t.diagnostic(`총 ${summary.totals.sent}건, 실패 ${summary.totals.failure}건, 순단 ${summary.outages.length}회`)

  // 1. 순단이 정확히 1건
  assert.equal(summary.outages.length, 1, `순단이 ${summary.outages.length}회 잡혔다`)

  // 2. 지속 시간이 3초 근처. 타임아웃(400ms)과 재기동 시간을 감안해 폭을 준다
  const { durationMs } = summary.outages[0]
  assert.ok(durationMs >= 2500 && durationMs <= 4500, `순단 지속 시간이 ${durationMs}ms 로 예상 밖이다`)

  // 3. 중단 구간에도 요청이 계속 나갔어야 한다.
  //    응답을 기다린 뒤 다음을 쏘는 구현이었다면 이 건수가 크게 모자란다.
  //    20rps × 3초 = 60건이 이론값. 절반 이상은 나갔어야 한다.
  assert.ok(summary.totals.failure >= 30, `중단 구간 실패가 ${summary.totals.failure}건뿐이다 — 발사가 멈춘 것으로 보인다`)

  // 4. 복구 후 다시 성공했다
  assert.ok(summary.totals.success > 40, `성공이 ${summary.totals.success}건뿐이다`)

  // 5. 설정한 속도대로 쏘지 못한 구간이 없어야 한다
  assert.equal(summary.totals.dropped, 0, '요청을 설정대로 쏘지 못했다')

  t.diagnostic(`경과 ${Date.now() - started}ms`)
})

test('멀쩡한 대상에는 순단이 잡히지 않는다', async () => {
  const server = await startServer()
  try {
    const scenario = {
      name: '대조군',
      target: {
        url: `http://127.0.0.1:${server.address().port}/signup`,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{}', timeoutMs: 1000,
      },
      success: { statusCodes: [201] },
      load: { rps: 20, durationSec: 3 },
      analysis: { slowThresholdMs: 1000, baselineSec: 1, minConsecutiveFailures: 3 },
    }

    const run = createRun({ scenario, prober: createProber('internal') })
    await run.start()

    const summary = run.summary()
    assert.equal(summary.outages.length, 0, '끊긴 적이 없는데 순단이 잡혔다')
    assert.equal(summary.downtimeMs, 0)
    assert.equal(summary.totals.failure, 0)
    assert.deepEqual(summary.warnings, [])
  } finally {
    await killServer(server)
  }
})
