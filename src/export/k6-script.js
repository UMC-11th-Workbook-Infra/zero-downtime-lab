/** JS 한 줄 주석과 작은따옴표 문자열 리터럴을 둘 다 끝내버리는 두 줄바꿈류 문자 */
const LINE_SEPARATOR = String.fromCodePoint(0x2028) // U+2028 LINE SEPARATOR
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029) // U+2029 PARAGRAPH SEPARATOR

/**
 * 문자열을 템플릿 리터럴 안에 넣을 수 있게 만들고 플레이스홀더를 k6 표현식으로 바꾼다.
 *
 * 이스케이프를 먼저 하고 치환을 나중에 해야 한다.
 * 순서를 바꾸면 방금 만든 ${...} 까지 이스케이프돼 버린다.
 */
function toTemplateLiteralBody(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{uuid\}\}/g, '${uuid()}')
    .replace(/\{\{counter\}\}/g, '${__VU}_${__ITER}')
    .replace(/\{\{timestamp\}\}/g, '${Date.now()}')
    .replace(/\{\{random\}\}/g, '${randomToken()}')
}

/**
 * 작은따옴표(') 문자열 리터럴 안에 그대로 넣을 수 있게 이스케이프한다.
 *
 * url 은 폼 입력값이라 아포스트로피나 줄바꿈이 섞여 들어올 수 있다.
 * 이스케이프 없이 '${url}' 로 찍으면 문자열이 조기 종료되며 스크립트가
 * 구문 오류가 나거나, 최악의 경우 그 뒤에 임의의 코드가 이어붙는다.
 */
function toSingleQuotedLiteral(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029')
}

/**
 * 한 줄 주석(//) 뒤에 그대로 넣을 수 있게 줄바꿈류 문자를 없앤다.
 *
 * JS 의 한 줄 주석은 LF/CR/U+2028/U+2029 어느 것으로도 끝난다. scenario.name
 * 에 줄바꿈이 있으면 주석이 거기서 끊기고 다음 줄이 스크립트 코드로
 * 해석돼 구문이 깨진다.
 */
function toCommentSafe(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .split(LINE_SEPARATOR).join(' ')
    .split(PARAGRAPH_SEPARATOR).join(' ')
}

/**
 * 헤더 맵을 k6 스크립트의 객체 리터럴로 만든다.
 *
 * 값도 바디와 똑같이 템플릿 리터럴로 감싼다. 스펙상 치환자는
 * 바디뿐 아니라 헤더에서도 동작하므로, JSON.stringify 로 그냥 찍으면
 * {{uuid}} 가 문자 그대로 남아 요청 헤더에 리터럴로 실려 나간다.
 */
function toHeadersLiteral(headers) {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return '{}'
  const lines = entries.map(([key, value]) =>
    `      ${JSON.stringify(key)}: \`${toTemplateLiteralBody(value)}\``)
  return `{\n${lines.join(',\n')}\n    }`
}

/**
 * 이 랩의 시나리오를 k6 스크립트로 옮긴다.
 *
 * 부하테스트 챕터의 출발점으로 쓰라고 만드는 것이라,
 * 램프업으로 바꾸는 방법을 주석으로 남긴다.
 *
 * @param {object} scenario
 * @returns {string}
 */
export function toK6Script(scenario) {
  const { url, method, headers, body, timeoutMs } = scenario.target
  const { rps, durationSec } = scenario.load
  const codes = JSON.stringify(scenario.success.statusCodes)
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const call = `http.${method.toLowerCase()}`
  const safeUrl = toSingleQuotedLiteral(url)

  return `// zero-downtime-lab 에서 내보낸 k6 스크립트
// 시나리오: ${toCommentSafe(scenario.name)}
//
// 실행:  k6 run deploy-test.js
//
// 이 랩은 "배포 중 끊기는가" 를 재는 도구라 고정 레이트로만 쏜다.
// 부하테스트를 하려면 아래 scenarios 를 ramping-arrival-rate 로 바꾸고
// stages 로 단계를 올려가며 한계점을 찾으면 된다.

import http from 'k6/http'
import { check } from 'k6'

export const options = {
  scenarios: {
    steady: {
      // constant-arrival-rate 는 개방형 모델이다.
      // 응답이 느려져도 발사 속도가 유지되므로 유실 구간의 표본이 사라지지 않는다.
      executor: 'constant-arrival-rate',
      rate: ${rps},
      timeUnit: '1s',
      duration: '${durationSec}s',
      preAllocatedVUs: ${Math.max(2, Math.ceil(rps * (timeoutMs / 1000)))},
      maxVUs: ${Math.max(10, Math.ceil(rps * (timeoutMs / 1000) * 4))},
    },
  },
  thresholds: {
    // 배포 중 단 한 건도 실패하지 않아야 통과한다
    checks: ['rate==1.00'],
  },
}

const SUCCESS_CODES = ${codes}

/** 랩의 uuid 치환자에 대응한다 */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 랩의 random 치환자에 대응한다 */
function randomToken() {
  return Math.random().toString(36).slice(2, 10)
}

export default function () {
  const params = {
    headers: ${toHeadersLiteral(headers)},
    timeout: '${timeoutMs}ms',
    redirects: 0, // 3xx 를 따라가지 않는다. 랩과 판정 기준을 맞추기 위해서다.
  }

${hasBody
    ? `  // 회원가입은 같은 값으로 두 번 부르면 두 번째가 실패하므로 매번 고유한 값을 만든다\n  const body = \`${toTemplateLiteralBody(body)}\`\n  const res = ${call}('${safeUrl}', body, params)`
    : `  const res = ${call}('${safeUrl}', params)`}

  check(res, {
    '성공 상태코드': (r) => SUCCESS_CODES.indexOf(r.status) !== -1,
  })
}
`
}
