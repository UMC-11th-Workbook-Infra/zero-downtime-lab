import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/api/routes.js'

/** 테스트용으로 앱을 임의 포트에 띄우고 base URL을 돌려준다 */
async function listen(app) {
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() }
}

test('GET /api/health 는 ok 를 반환한다', async () => {
  const { base, close } = await listen(createApp())
  try {
    const res = await fetch(`${base}/api/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
  } finally {
    close()
  }
})
