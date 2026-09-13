import { createApp } from './api/routes.js'

const port = Number(process.env.PORT ?? 9376)

createApp().listen(port, () => {
  console.log(`[lab] http://localhost:${port} 에서 대기 중`)
})
