import { randomUUID } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 8자리 영숫자를 만든다. 테스트 데이터 식별용이라 암호학적 강도는 필요 없다. */
function randomToken() {
  let out = ''
  for (let i = 0; i < 8; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}

/**
 * 요청 바디나 헤더 값의 플레이스홀더를 치환한다.
 *
 * 같은 토큰이 여러 번 나오면 각각 독립적으로 생성한다.
 * 이메일과 닉네임에 서로 다른 값이 들어가야 하기 때문이다.
 *
 * @param {string} text
 * @param {{ counter: number, now: number }} ctx
 * @returns {string}
 */
export function renderTemplate(text, ctx) {
  if (typeof text !== 'string') return text

  return text.replace(/\{\{(uuid|counter|timestamp|random)\}\}/g, (_, token) => {
    switch (token) {
      case 'uuid': return randomUUID()
      case 'counter': return String(ctx.counter)
      case 'timestamp': return String(ctx.now)
      case 'random': return randomToken()
      default: return ''
    }
  })
}

/**
 * 헤더 맵의 값에 같은 치환을 적용한다. 키는 건드리지 않는다.
 *
 * @param {Record<string,string>} headers
 * @param {{ counter: number, now: number }} ctx
 * @returns {Record<string,string>}
 */
export function renderHeaders(headers, ctx) {
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = renderTemplate(value, ctx)
  }
  return out
}
