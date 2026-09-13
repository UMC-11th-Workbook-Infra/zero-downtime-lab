import express from 'express'

/** 라우트가 붙은 Express 앱을 만든다. listen 은 호출부의 몫이다. */
export function createApp() {
  const app = express()
  app.use(express.json({ limit: '256kb' }))

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
