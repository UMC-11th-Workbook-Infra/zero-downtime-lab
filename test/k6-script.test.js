import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toK6Script } from '../src/export/k6-script.js'

const scenario = {
  name: '회원가입 유실 측정',
  target: {
    url: 'https://api.example.com/users/signup',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': '{{uuid}}' },
    body: '{"email":"lab-{{uuid}}@test.local","nickname":"u{{counter}}","at":{{timestamp}}}',
    timeoutMs: 5000,
  },
  success: { statusCodes: [200, 201] },
  load: { rps: 20, durationSec: 300 },
  analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
}

test('생성된 스크립트가 구문상 올바른 ESM 이다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'k6-'))
  const file = join(dir, 'deploy-test.mjs')
  writeFileSync(file, toK6Script(scenario))
  // 예외가 나지 않으면 구문이 올바른 것이다
  execFileSync(process.execPath, ['--check', file])
})

test('URL, 메서드, 헤더가 그대로 들어간다', () => {
  const out = toK6Script(scenario)
  assert.ok(out.includes('https://api.example.com/users/signup'))
  assert.ok(out.includes('http.post'))
  assert.ok(out.includes('Content-Type'))
})

test('플레이스홀더가 k6 표현식으로 바뀐다', () => {
  const out = toK6Script(scenario)
  assert.ok(out.includes('${uuid()}'))
  assert.ok(out.includes('${__VU}_${__ITER}'))
  assert.ok(out.includes('${Date.now()}'))
  assert.ok(!out.includes('{{'), '랩 전용 치환자가 남아 있으면 안 된다')
  // 이스케이프와 치환의 순서가 뒤바뀌면 방금 만든 ${...} 까지 이스케이프돼
  // `\${uuid()}` 가 된다. includes('${uuid()}') 는 부분 문자열이라 그것도
  // 통과시켜 버리므로, 역슬래시가 붙지 않았다는 것을 따로 못박는다.
  assert.ok(!out.includes('\\${'), '이스케이프가 치환보다 나중에 실행되고 있다')
})

test('성공 판정과 실패율 0% 임계치가 들어간다', () => {
  const out = toK6Script(scenario)
  assert.ok(out.includes('[200,201]') || out.includes('[200, 201]'))
  assert.ok(out.includes('thresholds'))
  assert.ok(out.includes('rate==1.00') || out.includes("rate==1"))
})

test('개방형 실행기를 쓴다', () => {
  const out = toK6Script(scenario)
  assert.ok(out.includes('constant-arrival-rate'))
  assert.ok(out.includes('rate: 20'))
  assert.ok(out.includes("duration: '300s'"))
})

test('바디의 백틱과 달러 중괄호를 이스케이프한다', () => {
  const tricky = { ...scenario, target: { ...scenario.target, body: 'a`b ${notATemplate} c' } }
  const dir = mkdtempSync(join(tmpdir(), 'k6-'))
  const file = join(dir, 'tricky.mjs')
  writeFileSync(file, toK6Script(tricky))
  execFileSync(process.execPath, ['--check', file])
  assert.ok(toK6Script(tricky).includes('\\`'))
  assert.ok(toK6Script(tricky).includes('\\${notATemplate}'))
})

test('헤더의 치환자도 k6 표현식으로 바뀐다', () => {
  const out = toK6Script(scenario)
  // JSON.stringify 로 찍으면 {{uuid}} 가 문자 그대로 남는다
  assert.ok(out.includes('"X-Request-Id"'))
  assert.ok(/"X-Request-Id":\s*`\$\{uuid\(\)\}`/.test(out), '헤더 값이 템플릿 리터럴로 변환돼야 한다')
})

test('GET 에는 바디를 붙이지 않는다', () => {
  const get = { ...scenario, target: { ...scenario.target, method: 'GET', body: '' } }
  assert.ok(toK6Script(get).includes('http.get'))
})

test('URL 의 아포스트로피와 이름의 줄바꿈을 이스케이프해 구문을 깨뜨리지 않는다', () => {
  // url 은 '...' 작은따옴표 문자열 리터럴 안에, scenario.name 은 // 한 줄
  // 주석 뒤에 그대로 꽂힌다. 이스케이프 없이 넣으면 아포스트로피가 문자열을
  // 조기 종료시키고, 이름의 줄바꿈이 주석을 끊어 다음 줄이 코드로 해석된다.
  const tricky = {
    ...scenario,
    name: '위험한 이름\nconst pwned = true',
    target: { ...scenario.target, url: "https://api.example.com/users/it's-a-trap?x=1" },
  }

  const dir = mkdtempSync(join(tmpdir(), 'k6-'))
  const file = join(dir, 'injection.mjs')
  const out = toK6Script(tricky)
  writeFileSync(file, out)
  // 예외가 나지 않으면 구문이 올바른 것이다 — 아포스트로피나 줄바꿈이
  // 이스케이프되지 않았다면 여기서 구문 오류가 난다.
  execFileSync(process.execPath, ['--check', file])

  assert.ok(out.includes("it\\'s-a-trap"), 'URL 의 아포스트로피가 이스케이프돼야 한다')
  assert.ok(!out.includes("'https://api.example.com/users/it's-a-trap?x=1'"),
    '이스케이프되지 않은 아포스트로피가 그대로 남아있으면 안 된다')
  assert.ok(!out.includes('// 위험한 이름\nconst pwned = true'),
    '이름의 줄바꿈이 주석 밖으로 코드를 이어붙이면 안 된다')
})
