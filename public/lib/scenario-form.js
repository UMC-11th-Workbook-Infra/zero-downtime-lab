/**
 * "이름: 값" 줄들을 헤더 객체로 바꾼다.
 * 값에 콜론이 들어갈 수 있으므로 첫 콜론에서만 자른다.
 */
export function headersFromText(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const index = trimmed.indexOf(':')
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

export function headersToText(headers) {
  return Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
}

/** "200, 201" 을 [200, 201] 로 */
export function statusCodesFromText(text) {
  return String(text ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 599)
}

/** 폼 값 묶음을 서버가 받는 시나리오 형태로 만든다 */
export function buildScenario(values) {
  return {
    name: values.name,
    target: {
      url: values.url.trim(),
      method: values.method,
      headers: headersFromText(values.headersText),
      body: values.body,
      timeoutMs: Number(values.timeoutMs),
    },
    success: { statusCodes: statusCodesFromText(values.statusCodesText) },
    load: { rps: Number(values.rps), durationSec: Number(values.durationSec) },
    analysis: {
      slowThresholdMs: Number(values.slowThresholdMs),
      baselineSec: Number(values.baselineSec),
      minConsecutiveFailures: Number(values.minConsecutiveFailures),
    },
  }
}
