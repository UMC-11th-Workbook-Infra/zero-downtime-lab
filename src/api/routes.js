import express from 'express'
import { DEFAULTS, validateScenario } from './validate-scenario.js'
import { openSseStream } from './sse.js'
import { createRun } from '../run/run.js'
import { createRunStore } from '../run/run-store.js'
import { createProber } from '../prober/index.js'
import { toK6Script } from '../export/k6-script.js'

/**
 * 라우트가 붙은 Express 앱을 만든다. listen 은 호출부의 몫이다.
 *
 * @param {{ store?: object, proberFactory?: () => object }} deps
 *   테스트에서 가짜 프로버를 끼우기 위해 주입 가능하게 열어둔다.
 */
export function createApp({ store = createRunStore({ max: 10 }), proberFactory = () => createProber('internal') } = {}) {
  const app = express()
  app.use(express.json({ limit: '256kb' }))
  app.use(express.static('public'))

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

  app.get('/api/defaults', (req, res) => res.json(DEFAULTS))

  app.post('/api/runs', (req, res) => {
    if (store.active() !== undefined) {
      return res.status(409).json({ errors: ['이미 실행 중인 측정이 있습니다. 먼저 중지해주세요.'] })
    }

    const result = validateScenario(req.body)
    if (!result.ok) return res.status(400).json({ errors: result.errors })

    const run = createRun({ scenario: result.scenario, prober: proberFactory() })
    store.add(run)
    // 실행은 백그라운드로 돌리고 응답은 즉시 돌려준다
    run.start().catch((err) => console.error('[lab] 실행 중 오류:', err))

    res.status(201).json({ runId: run.id })
  })

  app.post('/api/runs/:id/stop', (req, res) => {
    const run = store.get(req.params.id)
    if (run === undefined) return res.status(404).json({ errors: ['없는 실행입니다.'] })
    run.stop()
    res.json({ status: run.status })
  })

  app.get('/api/runs', (req, res) => {
    res.json(store.list().map((run) => ({
      runId: run.id,
      name: run.scenario.name,
      url: run.scenario.target.url,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })))
  })

  app.get('/api/runs/:id/export.json', (req, res) => {
    const run = store.get(req.params.id)
    if (run === undefined) return res.status(404).json({ errors: ['없는 실행입니다.'] })
    res.set('Content-Disposition', `attachment; filename="lab-${run.id.slice(0, 8)}.json"`)
    res.json({ scenario: run.scenario, summary: run.summary(), buckets: run.buckets() })
  })

  app.get('/api/runs/:id/export.k6.js', (req, res) => {
    const run = store.get(req.params.id)
    if (run === undefined) return res.status(404).json({ errors: ['없는 실행입니다.'] })
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.set('Content-Disposition', 'attachment; filename="deploy-test.js"')
    res.send(toK6Script(run.scenario))
  })

  app.get('/api/runs/:id', (req, res) => {
    const run = store.get(req.params.id)
    if (run === undefined) return res.status(404).json({ errors: ['없는 실행입니다.'] })
    res.json(run.summary())
  })

  app.get('/api/runs/:id/stream', (req, res) => {
    const run = store.get(req.params.id)
    if (run === undefined) return res.status(404).json({ errors: ['없는 실행입니다.'] })

    const lastEventId = Number(req.get('Last-Event-ID') ?? req.query.lastEventId ?? 0) || 0
    const stream = openSseStream(res, { lastEventId })

    // 연결 직후 현재 상태를 따라잡게 한다
    stream.send('state', { status: run.status, runId: run.id })
    run.buckets().forEach((bucket, index) => {
      const id = index + 1
      if (id > lastEventId) stream.send('bucket', bucket, id)
    })
    run.outages().forEach((outage) => stream.send('outage', outage))
    stream.send('summary', run.summary())

    let bucketId = run.buckets().length
    /** @type {Array<() => void>} 구독 해제 함수들 */
    const off = [
      run.on('bucket', (bucket) => { bucketId += 1; stream.send('bucket', bucket, bucketId) }),
      run.on('outage', (outage) => stream.send('outage', outage)),
      run.on('summary', (summary) => stream.send('summary', summary)),
      run.on('state', (state) => stream.send('state', state)),
    ]

    // 실행이 끝나면 마지막 요약을 보내고 연결을 닫는다
    off.push(run.on('state', (state) => {
      if (state.status === 'running') return
      stream.send('summary', run.summary())
      finish()
    }))

    function finish() {
      // 구독을 전부 해제한다. 두 번 불려도 안전하다.
      while (off.length > 0) off.pop()()
      stream.close()
    }

    // 이미 끝난 실행이면 따라잡기만 하고 바로 닫는다
    if (run.status !== 'running') {
      finish()
      return
    }

    req.on('close', finish)
  })

  return app
}
