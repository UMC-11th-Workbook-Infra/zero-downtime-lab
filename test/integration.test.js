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

  try {
    await run.start()
  } finally {
    // 단언이 터지더라도 되살아난 서버를 반드시 닫는다.
    // 스크립트가 서버를 재시작한 뒤일 수 있으므로 먼저 끝나기를 기다린다.
    await outageScript.catch(() => {})
    await killServer(server)
  }

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

test('타임아웃으로 끊겨 완료 순서가 뒤집혀도 순단은 1건이다', async (t) => {
  // 이 테스트가 없으면 sequence-buffer 가 통째로 망가져도 통합 테스트는 통과한다.
  //
  // 위의 커넥션 끊기 방식은 ECONNREFUSED 로 즉시 실패해서, 완료 순서가
  // 발사 순서와 사실상 같다. 순서 복원이 필요한 상황이 아예 만들어지지 않는다.
  //
  // 여기서는 응답을 붙잡아 타임아웃을 낸다. 그러면 먼저 발사된 실패가
  // 나중에 발사된 성공보다 늦게 완료된다 — 순서를 복원하지 않으면
  // 연속 실패 구간이 성공으로 잘려 순단이 여러 건으로 쪼개진다.
  t.diagnostic('응답을 3초간 붙잡아 타임아웃을 만든다')

  let hanging = false
  /** 붙잡아 둔 응답들. 끝나면 버린다. */
  const held = []
  const server = createServer((req, res) => {
    req.resume()
    if (hanging) {
      held.push(res)
      return
    }
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.listen(0)
  await new Promise((r) => server.once('listening', r))

  const scenario = {
    name: '타임아웃 순단',
    target: {
      url: `http://127.0.0.1:${server.address().port}/signup`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local"}',
      timeoutMs: 400,
    },
    success: { statusCodes: [201] },
    load: { rps: 20, durationSec: 8 },
    analysis: { slowThresholdMs: 1000, baselineSec: 1, minConsecutiveFailures: 3 },
  }

  const run = createRun({ scenario, prober: createProber('internal') })
  const script = (async () => {
    await sleep(2000)
    hanging = true
    await sleep(3000)
    hanging = false
    // 클라이언트는 이미 타임아웃으로 끊었다. 남은 소켓만 정리한다.
    held.forEach((res) => res.destroy())
    held.length = 0
  })()

  try {
    await run.start()
  } finally {
    await script.catch(() => {})
    await killServer(server)
  }

  const summary = run.summary()
  t.diagnostic(`총 ${summary.totals.sent}건, 타임아웃 ${summary.totals.byType.timeout}건, 순단 ${summary.outages.length}회`)

  // 순서 복원이 깨지면 성공 레코드가 실패 구간 한가운데로 끼어들어
  // 하나였던 순단이 둘 이상으로 쪼개진다.
  assert.equal(summary.outages.length, 1, `순단이 ${summary.outages.length}회로 쪼개졌다 — 완료 순서가 발사 순서로 복원되지 않았을 수 있다`)
  assert.ok(summary.totals.byType.timeout > 30, `타임아웃이 ${summary.totals.byType.timeout}건뿐이다 — 붙잡기가 동작하지 않았다`)
  assert.equal(summary.totals.dropped, 0, '요청을 설정대로 쏘지 못했다')
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
