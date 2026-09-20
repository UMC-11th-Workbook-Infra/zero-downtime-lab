const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

/** 폼 기본값이자 검증 기본값. 프론트엔드도 이 값을 받아 쓴다. */
export const DEFAULTS = {
  name: '배포 유실 측정',
  target: {
    url: '',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email":"lab-{{uuid}}@test.local","password":"Test1234!","nickname":"u{{counter}}"}',
    timeoutMs: 5000,
  },
  success: { statusCodes: [200, 201] },
  load: { rps: 20, durationSec: 300 },
  analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
}

/** 숫자를 범위와 함께 검사한다 */
function num(value, fallback, { min, max, label }, errors) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(n)) {
    errors.push(`${label}에 숫자를 넣어주세요.`)
    return fallback
  }
  if (n < min || n > max) {
    errors.push(`${label}은(는) ${min} 이상 ${max} 이하여야 합니다. (받은 값: ${n})`)
    return fallback
  }
  return n
}

/**
 * 폼에서 온 시나리오를 검증하고 기본값을 채운다.
 *
 * 잘못된 설정으로 5분을 돌린 뒤에 알게 되는 것을 막는 것이 목적이므로,
 * 오류는 첫 번째에서 멈추지 않고 전부 모아서 돌려준다.
 *
 * @param {object} input
 * @returns {{ ok: true, scenario: object } | { ok: false, errors: string[] }}
 */
export function validateScenario(input = {}) {
  const errors = []
  const t = input.target ?? {}

  // URL
  let url = ''
  if (typeof t.url !== 'string' || t.url.trim() === '') {
    errors.push('대상 주소를 입력해주세요.')
  } else {
    try {
      const parsed = new URL(t.url.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('대상 주소는 http 또는 https 여야 합니다.')
      } else {
        url = parsed.toString()
      }
    } catch {
      errors.push(`대상 주소의 형식이 올바르지 않습니다: ${t.url}`)
    }
  }

  // 메서드
  const method = String(t.method ?? DEFAULTS.target.method).toUpperCase()
  if (!METHODS.includes(method)) {
    errors.push(`지원하지 않는 메서드입니다: ${method} (가능: ${METHODS.join(', ')})`)
  }

  // 헤더
  const headers = t.headers ?? DEFAULTS.target.headers
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    errors.push('헤더는 이름-값 쌍이어야 합니다.')
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') errors.push(`헤더 ${key} 의 값은 문자열이어야 합니다.`)
    }
  }

  const timeoutMs = num(t.timeoutMs, DEFAULTS.target.timeoutMs, { min: 100, max: 60_000, label: '타임아웃' }, errors)

  // 성공 상태코드
  const codes = input.success?.statusCodes ?? DEFAULTS.success.statusCodes
  if (!Array.isArray(codes) || codes.length === 0) {
    errors.push('성공으로 볼 상태코드를 하나 이상 지정해주세요.')
  } else if (!codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599)) {
    errors.push('성공 상태코드는 100~599 사이의 정수여야 합니다.')
  }

  const rps = num(input.load?.rps, DEFAULTS.load.rps, { min: 1, max: 200, label: '초당 요청 수' }, errors)

  const errorCountBeforeDuration = errors.length
  const durationSec = num(input.load?.durationSec, DEFAULTS.load.durationSec, { min: 5, max: 3600, label: '실행 시간' }, errors)
  const durationHasError = errors.length > errorCountBeforeDuration

  const slowThresholdMs = num(input.analysis?.slowThresholdMs, DEFAULTS.analysis.slowThresholdMs, { min: 1, max: 60_000, label: '지연 임계값' }, errors)
  const userBaselineSec = input.analysis?.baselineSec
  const errorCountBeforeBaseline = errors.length
  const baselineSec = num(userBaselineSec, DEFAULTS.analysis.baselineSec, { min: 5, max: 3600, label: '베이스라인 구간' }, errors)
  const baselineHasError = errors.length > errorCountBeforeBaseline

  const minConsecutiveFailures = num(input.analysis?.minConsecutiveFailures, DEFAULTS.analysis.minConsecutiveFailures, { min: 1, max: 100, label: '최소 연속 실패 수' }, errors)

  if (!durationHasError && !baselineHasError && baselineSec >= durationSec) {
    const reportedBaseline = userBaselineSec === undefined || userBaselineSec === null || userBaselineSec === '' ? baselineSec : userBaselineSec
    errors.push(`베이스라인 구간(${reportedBaseline}초)은 실행 시간(${durationSec}초)보다 짧아야 합니다.`)
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    scenario: {
      name: typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : DEFAULTS.name,
      target: { url, method, headers, body: typeof t.body === 'string' ? t.body : '', timeoutMs },
      success: { statusCodes: codes },
      load: { rps, durationSec },
      analysis: { slowThresholdMs, baselineSec, minConsecutiveFailures },
    },
  }
}
