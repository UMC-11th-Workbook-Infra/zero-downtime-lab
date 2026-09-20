const HEARTBEAT_MS = 15_000

/**
 * SSE 응답을 연다.
 *
 * @param {import('express').Response} res
 * @param {{ lastEventId?: number }} options
 */
export function openSseStream(res, { lastEventId = 0 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 프록시가 버퍼링하면 실시간이 아니게 된다
    'X-Accel-Buffering': 'no',
  })

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  return {
    lastEventId,
    send(event, data, id) {
      if (res.writableEnded) return
      if (id !== undefined) res.write(`id: ${id}\n`)
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    },
    close() {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    },
  }
}
