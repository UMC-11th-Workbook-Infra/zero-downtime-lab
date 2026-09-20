# 배포 유실 측정 랩 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 배포하는 동안 요청이 몇 건 유실되고 몇 초 끊겼는지를 로컬 웹 화면에서 확인하는 도구를 만든다.

**Architecture:** Node 단일 서비스가 대상 앱에 고정 레이트로 요청을 쏘고, 요청 1건마다 레코드를 만든다. 집계·순단 감지·베이스라인은 모두 그 레코드 스트림 하나에만 의존하는 순수 함수 단위로 분리하고, 결과는 SSE로 브라우저에 밀어 보낸다. 요청을 실제로 쏘는 부분은 `Prober` 인터페이스 뒤에 두어 나중에 k6 구현체로 갈아끼울 수 있게 한다.

**Tech Stack:** Node 20+ (ESM), Express, `node:test` 내장 테스트 러너, uPlot(벤더링), Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-13-zero-downtime-lab-design.md`

## Global Constraints

- 런타임은 Node 20 이상. 개발 환경은 v24.8.0
- `package.json` 에 `"type": "module"`. 모든 소스는 ESM (`import`/`export`)
- 빌드 단계를 두지 않는다. 프론트엔드는 바닐라 JS, 번들러 없음
- 런타임 의존성은 `express` 하나뿐. 그 외는 Node 표준 모듈만 쓴다 (UUID는 `crypto.randomUUID()`)
- 테스트는 `node:test` 내장 러너. 실행 명령은 `npm test` (= `node --test`)
- 테스트 파일은 `test/<모듈명>.test.js`
- 기본 포트는 `9376`. `PORT` 환경변수로 변경 가능
- 코드 주석과 UI 문구는 한국어로 쓴다
- uPlot은 `public/vendor/` 에 벤더링해서 리포지토리에 커밋한다. 런타임에 CDN을 타지 않는다 (오프라인 동작 보장)
- 시간은 전부 `Date.now()` 기준 epoch ms. 변수명은 `ts`, 초 단위는 `tsSec`
- 레코드 형태는 전 구간에서 고정이다:
  `{ seq: number, ts: number, status: number|null, durationMs: number|null, outcome: 'success'|'failure', failureType: null|'network'|'timeout'|'server'|'client', error: string|null }`

---

### Task 1: 프로젝트 뼈대와 헬스체크

서버가 뜨고 `/api/health` 가 응답하는 것까지. 이후 모든 작업이 얹힐 바닥이다.

**Files:**
- Create: `package.json`
- Create: `src/server.js`
- Create: `src/api/routes.js`
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Verify: `.gitignore` (이미 존재한다 — 아래 내용이 들어 있는지 확인만 하고, 없으면 추가한다. `.superpowers/` 줄은 지우지 말 것)
- Create: `public/.gitkeep` (Dockerfile 의 `COPY public` 이 성립하려면 이 시점에 디렉터리가 있어야 한다. Task 15에서 실제 화면으로 채운다)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `createApp() -> express.Application` (`src/api/routes.js`) — 라우트가 붙은 Express 앱을 반환한다. 서버를 listen 하지는 않는다
  - `src/server.js` 는 `createApp()` 을 받아 `process.env.PORT ?? 9376` 으로 listen 한다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/server.test.js`:

```js
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/api/routes.js'`

- [ ] **Step 3: 최소 구현 작성**

`package.json`:

```json
{
  "name": "zero-downtime-lab",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
```

`src/api/routes.js`:

```js
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
```

`src/server.js`:

```js
import { createApp } from './api/routes.js'

const port = Number(process.env.PORT ?? 9376)

createApp().listen(port, () => {
  console.log(`[lab] http://localhost:${port} 에서 대기 중`)
})
```

`Dockerfile`:

```dockerfile
FROM node:22-alpine

WORKDIR /app

# 의존성을 먼저 설치해 레이어 캐시를 살린다
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=9376
EXPOSE 9376

CMD ["node", "src/server.js"]
```

`docker-compose.yml`:

```yaml
services:
  lab:
    build: .
    # 호스트 포트가 이미 점유돼 있으면 왼쪽 숫자만 바꾸면 된다
    ports:
      - "${PORT:-9376}:9376"
    restart: unless-stopped
```

`.dockerignore`:

```
node_modules
test
docs
.git
```

`.gitignore` — 이미 아래와 같이 있어야 한다 (없는 줄만 추가한다):

```
node_modules
*.log
.superpowers/
```

빈 `public/` 디렉터리도 만들어 둔다. Dockerfile 이 이 경로를 복사하므로 없으면 빌드가 깨진다.

```bash
mkdir -p public && touch public/.gitkeep
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm install && npm test`
Expected: PASS — 1 test

- [ ] **Step 5: 커밋**

```bash
git add package.json package-lock.json src public/.gitkeep Dockerfile docker-compose.yml .dockerignore .gitignore test
git commit -m "feat: 프로젝트 뼈대와 헬스체크 엔드포인트"
```

---

### Task 2: 실패 분류 (classify)

응답이나 예외를 `outcome` 과 `failureType` 으로 나누는 순수 함수. 인터넷 구간 노이즈와 앱 장애를 구분하는 근거가 여기서 만들어진다.

**Files:**
- Create: `src/prober/classify.js`
- Test: `test/classify.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `classify(result, successStatusCodes) -> { outcome, failureType }`
    - `result`: `{ status?: number, timedOut?: boolean, errorCode?: string }`
    - `successStatusCodes`: `number[]`
    - 반환: `{ outcome: 'success'|'failure', failureType: null|'network'|'timeout'|'server'|'client' }`

판정 순서는 아래대로 고정한다. 순서가 결과를 바꾸므로 임의로 바꾸지 말 것.

1. `timedOut` 이 true → `failure` / `timeout`
2. `status` 가 없음 (`errorCode` 만 있음) → `failure` / `network`
3. `status` 가 `successStatusCodes` 에 포함 → `success` / `null`
4. `status >= 500` → `failure` / `server`
5. 그 외 전부 → `failure` / `client`

4xx뿐 아니라 3xx와 성공 목록에 없는 2xx도 `client` 로 떨어진다. 셋 다 "폼 설정이 대상 앱과 안 맞다"는 같은 신호이기 때문이다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/classify.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/prober/classify.js'

const OK = [200, 201]

test('성공 목록에 있는 상태코드는 성공이다', () => {
  assert.deepEqual(classify({ status: 201 }, OK), { outcome: 'success', failureType: null })
})

test('성공 목록에 409 를 넣으면 409 가 성공이 된다', () => {
  assert.deepEqual(classify({ status: 409 }, [200, 201, 409]), { outcome: 'success', failureType: null })
})

test('5xx 는 server 실패다', () => {
  assert.deepEqual(classify({ status: 503 }, OK), { outcome: 'failure', failureType: 'server' })
})

test('성공 목록 밖 4xx 는 client 실패다', () => {
  assert.deepEqual(classify({ status: 422 }, OK), { outcome: 'failure', failureType: 'client' })
})

test('3xx 는 따라가지 않고 client 실패로 분류된다', () => {
  assert.deepEqual(classify({ status: 302 }, OK), { outcome: 'failure', failureType: 'client' })
})

test('타임아웃은 timeout 실패다', () => {
  assert.deepEqual(classify({ timedOut: true }, OK), { outcome: 'failure', failureType: 'timeout' })
})

test('커넥션 거부는 network 실패다', () => {
  assert.deepEqual(classify({ errorCode: 'ECONNREFUSED' }, OK), { outcome: 'failure', failureType: 'network' })
})

test('DNS 실패는 network 실패다', () => {
  assert.deepEqual(classify({ errorCode: 'ENOTFOUND' }, OK), { outcome: 'failure', failureType: 'network' })
})

test('타임아웃 판정이 network 판정보다 우선한다', () => {
  // abort 로 끊긴 요청은 errorCode 도 같이 들고 오는 경우가 있다
  assert.deepEqual(
    classify({ timedOut: true, errorCode: 'ABORT_ERR' }, OK),
    { outcome: 'failure', failureType: 'timeout' },
  )
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/classify.test.js`
Expected: FAIL — `Cannot find module '../src/prober/classify.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/prober/classify.js`:

```js
/**
 * 요청 결과를 성공/실패와 실패 유형으로 나눈다.
 *
 * 판정 순서가 결과를 바꾸므로 아래 순서를 지킨다.
 *
 * @param {{ status?: number, timedOut?: boolean, errorCode?: string }} result
 * @param {number[]} successStatusCodes 사용자가 성공으로 지정한 상태코드
 * @returns {{ outcome: 'success'|'failure', failureType: null|'network'|'timeout'|'server'|'client' }}
 */
export function classify(result, successStatusCodes) {
  if (result.timedOut) {
    return { outcome: 'failure', failureType: 'timeout' }
  }

  // 응답 자체가 없었던 경우 (DNS, 커넥션, TLS)
  if (typeof result.status !== 'number') {
    return { outcome: 'failure', failureType: 'network' }
  }

  if (successStatusCodes.includes(result.status)) {
    return { outcome: 'success', failureType: null }
  }

  if (result.status >= 500) {
    return { outcome: 'failure', failureType: 'server' }
  }

  // 4xx, 3xx, 성공 목록에 없는 2xx 전부.
  // 셋 다 폼 설정이 대상 앱과 맞지 않는다는 같은 신호다.
  return { outcome: 'failure', failureType: 'client' }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/classify.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/prober/classify.js test/classify.test.js
git commit -m "feat: 요청 결과를 실패 유형별로 분류"
```

---

### Task 3: 플레이스홀더 치환 (request-template)

회원가입은 같은 값으로 두 번 부르면 두 번째가 실패한다. 매 요청 고유한 값을 만들어 넣는다.

**Files:**
- Create: `src/prober/request-template.js`
- Test: `test/request-template.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `renderTemplate(text, ctx) -> string`
    - `text`: 치환할 문자열 (바디 또는 헤더 값)
    - `ctx`: `{ counter: number, now: number }`
  - `renderHeaders(headers, ctx) -> Record<string,string>` — 헤더 값에도 같은 치환을 적용한다

지원 토큰은 네 개뿐이다. 같은 토큰이 여러 번 나오면 **각각 독립적으로** 생성한다 (이메일과 닉네임에 서로 다른 값이 들어가야 하므로).

| 토큰 | 치환 결과 |
|---|---|
| `{{uuid}}` | `crypto.randomUUID()` |
| `{{counter}}` | `ctx.counter` |
| `{{timestamp}}` | `ctx.now` |
| `{{random}}` | 8자리 영숫자 소문자+숫자 |

- [ ] **Step 1: 실패하는 테스트 작성**

`test/request-template.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate, renderHeaders } from '../src/prober/request-template.js'

const ctx = { counter: 7, now: 1757740000000 }

test('치환자가 없는 문자열은 그대로 나간다', () => {
  assert.equal(renderTemplate('{"a":1}', ctx), '{"a":1}')
})

test('{{counter}} 는 요청 일련번호로 바뀐다', () => {
  assert.equal(renderTemplate('u{{counter}}', ctx), 'u7')
})

test('{{timestamp}} 는 발사 시각으로 바뀐다', () => {
  assert.equal(renderTemplate('{{timestamp}}', ctx), '1757740000000')
})

test('{{uuid}} 는 UUID v4 형식으로 바뀐다', () => {
  const out = renderTemplate('{{uuid}}', ctx)
  assert.match(out, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('{{random}} 은 8자리 영숫자로 바뀐다', () => {
  assert.match(renderTemplate('{{random}}', ctx), /^[a-z0-9]{8}$/)
})

test('같은 토큰이 두 번 나오면 각각 다른 값이 된다', () => {
  const [a, b] = renderTemplate('{{uuid}} {{uuid}}', ctx).split(' ')
  assert.notEqual(a, b)
})

test('호출할 때마다 uuid 가 달라진다', () => {
  assert.notEqual(renderTemplate('{{uuid}}', ctx), renderTemplate('{{uuid}}', ctx))
})

test('실제 회원가입 바디 모양에서 동작한다', () => {
  const body = '{"email":"lab-{{uuid}}@test.local","nickname":"u{{counter}}"}'
  const out = JSON.parse(renderTemplate(body, ctx))
  assert.match(out.email, /^lab-[0-9a-f-]{36}@test\.local$/)
  assert.equal(out.nickname, 'u7')
})

test('헤더 값에도 치환이 적용된다', () => {
  const out = renderHeaders({ 'X-Request-Id': '{{uuid}}', 'Content-Type': 'application/json' }, ctx)
  assert.equal(out['Content-Type'], 'application/json')
  assert.match(out['X-Request-Id'], /^[0-9a-f-]{36}$/)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/request-template.test.js`
Expected: FAIL — `Cannot find module '../src/prober/request-template.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/prober/request-template.js`:

```js
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/request-template.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/prober/request-template.js test/request-template.test.js
git commit -m "feat: 요청 바디와 헤더의 플레이스홀더 치환"
```

---

### Task 4: 백분위수 계산 (percentiles)

p50/p95/p99를 계산한다. 빈 배열과 원소 1개 같은 경계가 실제로 발생하므로 (대상이 전부 타임아웃이면 응답 표본이 0개다) 그 경계를 테스트로 못박는다.

**Files:**
- Create: `src/analysis/percentiles.js`
- Test: `test/percentiles.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `percentile(sortedValues, p) -> number|null` — `sortedValues` 는 **오름차순 정렬된** 숫자 배열, `p` 는 0~100. 빈 배열이면 `null`
  - `summarizeDurations(values) -> { p50, p95, p99, max, count }` — 정렬은 내부에서 한다. 빈 배열이면 전부 `null`, `count` 는 0

계산 방식은 **nearest-rank** 로 고정한다: `index = ceil(p / 100 * n) - 1`, 0 미만은 0으로 자른다. 보간법보다 설명하기 쉽고, 표본이 적을 때 실제로 관측된 값만 나온다는 장점이 있다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/percentiles.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarizeDurations } from '../src/analysis/percentiles.js'

test('빈 배열의 백분위수는 null 이다', () => {
  assert.equal(percentile([], 95), null)
})

test('원소가 하나면 어떤 백분위수든 그 값이다', () => {
  assert.equal(percentile([42], 50), 42)
  assert.equal(percentile([42], 99), 42)
})

test('nearest-rank 로 계산한다', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  assert.equal(percentile(values, 50), 50)  // ceil(0.5*10)-1 = 4
  assert.equal(percentile(values, 95), 100) // ceil(0.95*10)-1 = 9
  assert.equal(percentile(values, 99), 100)
})

test('p0 은 최솟값이다', () => {
  assert.equal(percentile([10, 20, 30], 0), 10)
})

test('summarizeDurations 는 정렬을 알아서 한다', () => {
  const out = summarizeDurations([300, 100, 200])
  assert.equal(out.p50, 200)
  assert.equal(out.max, 300)
  assert.equal(out.count, 3)
})

test('summarizeDurations 는 빈 입력에서 전부 null 을 준다', () => {
  assert.deepEqual(summarizeDurations([]), { p50: null, p95: null, p99: null, max: null, count: 0 })
})

test('summarizeDurations 는 입력 배열을 변형하지 않는다', () => {
  const input = [300, 100, 200]
  summarizeDurations(input)
  assert.deepEqual(input, [300, 100, 200])
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/percentiles.test.js`
Expected: FAIL — `Cannot find module '../src/analysis/percentiles.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/analysis/percentiles.js`:

```js
/**
 * nearest-rank 방식 백분위수.
 *
 * 보간하지 않으므로 반환값은 항상 실제로 관측된 값이다.
 * 표본이 적은 구간에서 없던 숫자가 만들어지지 않는다.
 *
 * @param {number[]} sortedValues 오름차순 정렬된 값
 * @param {number} p 0~100
 * @returns {number|null} 표본이 없으면 null
 */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1
  const index = Math.min(Math.max(rank, 0), sortedValues.length - 1)
  return sortedValues[index]
}

/**
 * 응답 시간 배열을 요약한다. 정렬은 내부에서 하고 입력 배열은 건드리지 않는다.
 *
 * @param {number[]} values
 * @returns {{ p50: number|null, p95: number|null, p99: number|null, max: number|null, count: number }}
 */
export function summarizeDurations(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    count: sorted.length,
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/percentiles.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: 커밋**

```bash
git add src/analysis/percentiles.js test/percentiles.test.js
git commit -m "feat: nearest-rank 백분위수 계산"
```

---

### Task 5: 순단 감지 (outage-detector)

이 도구의 핵심이다. 여기가 틀리면 나머지가 다 맞아도 의미가 없다.

**Files:**
- Create: `src/analysis/outage-detector.js`
- Test: `test/outage-detector.test.js`

**Interfaces:**
- Consumes: 레코드 형태 (Global Constraints 참고)
- Produces:
  - `createOutageDetector({ minConsecutiveFailures }) -> detector`
  - `detector.push(record) -> Outage|null` — 순단이 **끝났을 때만** 그 순단을 반환한다. 그 외에는 `null`
  - `detector.finish() -> Outage|null` — 실행 종료 시 호출. 복구되지 않은 순단이 있으면 `ongoing: true` 로 반환
  - `detector.outages() -> Outage[]` — 지금까지 확정된 순단 전부
  - `Outage`: `{ startTs, endTs, durationMs, failureCount, byType, ongoing }`
    - `byType`: `{ network, timeout, server, client }` 각 유형별 건수

**판정 규칙 (스펙 4.6):**

- 순단 = 연속 실패 레코드가 `minConsecutiveFailures` 건 이상 이어진 구간
- 연속 실패가 그 미만이면 순단이 아니다. 인터넷 구간 노이즈를 걸러내기 위한 값이다
- 지속 시간 = **순단 직전 마지막 성공의 `ts`** 부터 **순단 이후 첫 성공의 `ts`** 까지. 실패 레코드의 시작·끝이 아니다. 사용자가 체감하는 단절은 성공과 성공 사이의 간격이기 때문이다
- **한 번도 성공한 적이 없으면 순단으로 치지 않는다.** 끊긴 게 아니라 애초에 닿은 적이 없는 것이다 (Task 10의 자동 중단이 처리한다)
- `finish()` 시점에 복구되지 않았으면 `endTs: null`, `ongoing: true`, `durationMs` 는 마지막 실패 `ts` 까지로 계산

- [ ] **Step 1: 실패하는 테스트 작성**

`test/outage-detector.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutageDetector } from '../src/analysis/outage-detector.js'

let seq = 0
/** 테스트용 레코드를 간단히 만든다 */
function rec(ts, outcome, failureType = null) {
  seq += 1
  return { seq, ts, status: null, durationMs: null, outcome, failureType, error: null }
}
const ok = (ts) => rec(ts, 'success')
const fail = (ts, type = 'timeout') => rec(ts, 'failure', type)

test('연속 실패 2건은 순단이 아니다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  assert.equal(d.push(ok(1150)), null)
  assert.deepEqual(d.outages(), [])
})

test('연속 실패 3건은 순단이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  d.push(fail(1150))
  const outage = d.push(ok(1200))
  assert.ok(outage)
  assert.equal(outage.failureCount, 3)
  assert.equal(outage.ongoing, false)
})

test('지속 시간은 직전 성공부터 다음 성공까지로 잰다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  d.push(fail(1100))
  d.push(fail(1150))
  const outage = d.push(ok(4000))
  // 실패 구간(1050~1150)이 아니라 성공과 성공 사이(1000~4000)를 잰다
  assert.equal(outage.startTs, 1000)
  assert.equal(outage.endTs, 4000)
  assert.equal(outage.durationMs, 3000)
})

test('실패 유형별로 건수를 센다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050, 'timeout'))
  d.push(fail(1100, 'timeout'))
  d.push(fail(1150, 'network'))
  const outage = d.push(ok(1200))
  assert.deepEqual(outage.byType, { network: 1, timeout: 2, server: 0, client: 0 })
})

test('순단이 두 번이면 둘로 분리된다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050)); d.push(fail(1100)); d.push(fail(1150))
  d.push(ok(1200))
  d.push(fail(2050)); d.push(fail(2100)); d.push(fail(2150))
  d.push(ok(2200))
  assert.equal(d.outages().length, 2)
  assert.equal(d.outages()[0].startTs, 1000)
  assert.equal(d.outages()[1].startTs, 1200)
})

test('한 번도 성공한 적이 없으면 순단으로 치지 않는다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(fail(1000, 'network'))
  d.push(fail(1050, 'network'))
  d.push(fail(1100, 'network'))
  assert.equal(d.push(ok(1150)), null)
  assert.deepEqual(d.outages(), [])
})

test('복구되지 않은 순단은 finish 에서 ongoing 으로 나온다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050)); d.push(fail(1100)); d.push(fail(1150))
  const outage = d.finish()
  assert.ok(outage)
  assert.equal(outage.ongoing, true)
  assert.equal(outage.endTs, null)
  assert.equal(outage.durationMs, 150) // 1000 -> 마지막 실패 1150
  assert.equal(d.outages().length, 1)
})

test('finish 시점에 진행 중인 순단이 없으면 null 이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 3 })
  d.push(ok(1000))
  d.push(fail(1050))
  assert.equal(d.finish(), null)
})

test('minConsecutiveFailures 를 1 로 두면 단발 실패도 순단이다', () => {
  const d = createOutageDetector({ minConsecutiveFailures: 1 })
  d.push(ok(1000))
  d.push(fail(1050))
  assert.ok(d.push(ok(1100)))
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/outage-detector.test.js`
Expected: FAIL — `Cannot find module '../src/analysis/outage-detector.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/analysis/outage-detector.js`:

```js
/** 실패 유형별 카운터를 0으로 초기화한다 */
function emptyByType() {
  return { network: 0, timeout: 0, server: 0, client: 0 }
}

/**
 * 레코드 스트림에서 순단 구간을 잡아낸다.
 *
 * 순단은 집계된 시계열이 아니라 개별 요청의 연속 실패에서만 보인다.
 * 그래서 버킷이 아니라 레코드를 직접 받는다.
 *
 * @param {{ minConsecutiveFailures: number }} options
 */
export function createOutageDetector({ minConsecutiveFailures }) {
  /** 마지막으로 성공한 요청의 시각. 한 번도 성공한 적 없으면 null */
  let lastSuccessTs = null
  /** 아직 복구되지 않은 연속 실패들 */
  let pending = []
  const confirmed = []

  /** pending 이 순단 기준을 넘는지 */
  function qualifies() {
    // 한 번도 성공한 적이 없으면 "끊긴" 게 아니라 애초에 닿은 적이 없는 것이다
    return lastSuccessTs !== null && pending.length >= minConsecutiveFailures
  }

  /** pending 을 순단 객체로 만든다 */
  function build(endTs, ongoing) {
    const byType = emptyByType()
    for (const record of pending) {
      if (record.failureType in byType) byType[record.failureType] += 1
    }
    // 진행 중이면 마지막 실패 시각까지로 잰다
    const measuredEnd = endTs ?? pending[pending.length - 1].ts
    return {
      startTs: lastSuccessTs,
      endTs,
      durationMs: measuredEnd - lastSuccessTs,
      failureCount: pending.length,
      byType,
      ongoing,
    }
  }

  return {
    /**
     * 레코드 하나를 흘려넣는다.
     * @returns {object|null} 순단이 끝났을 때만 그 순단을 반환한다
     */
    push(record) {
      if (record.outcome === 'failure') {
        pending.push(record)
        return null
      }

      // 성공 레코드: 진행 중이던 실패 구간을 닫는다
      let outage = null
      if (qualifies()) {
        outage = build(record.ts, false)
        confirmed.push(outage)
      }
      pending = []
      lastSuccessTs = record.ts
      return outage
    },

    /**
     * 실행 종료 시 호출한다.
     * @returns {object|null} 복구되지 않은 순단이 있으면 ongoing 으로 반환
     */
    finish() {
      if (!qualifies()) return null
      const outage = build(null, true)
      confirmed.push(outage)
      pending = []
      return outage
    },

    outages() {
      return confirmed
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/outage-detector.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/analysis/outage-detector.js test/outage-detector.test.js
git commit -m "feat: 연속 실패 구간을 순단으로 감지"
```

---

### Task 6: 베이스라인 (baseline)

배포 전 평상시 구간을 기준값으로 잡는다. 인터넷 구간 노이즈가 있어도 델타로 읽으면 유실 판정이 선명해진다.

**Files:**
- Create: `src/analysis/baseline.js`
- Test: `test/baseline.test.js`

**Interfaces:**
- Consumes: `summarizeDurations` (Task 4), 레코드 형태
- Produces:
  - `createBaseline({ startTs, baselineSec }) -> baseline`
  - `baseline.push(record) -> void` — 베이스라인 창 안의 레코드만 반영한다. 창을 넘어선 레코드는 무시
  - `baseline.result() -> { complete, sampleCount, failureRate, clientFailureRate, p95 }`
    - `failureRate`, `clientFailureRate`: 0~1 비율. 표본이 없으면 `null`
    - `complete`: 베이스라인 창이 끝났는지 (`push` 로 창 밖 레코드를 한 번이라도 받았으면 true)

`clientFailureRate` 를 따로 내는 이유는 Task 10의 "폼 설정을 확인하세요" 경고 판정에 쓰기 위해서다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/baseline.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBaseline } from '../src/analysis/baseline.js'

const T0 = 1_000_000
let seq = 0
function rec(offsetMs, outcome, failureType = null, durationMs = 100) {
  seq += 1
  return {
    seq, ts: T0 + offsetMs, status: null, durationMs,
    outcome, failureType, error: null,
  }
}

test('표본이 없으면 비율은 null 이다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  assert.deepEqual(b.result(), {
    complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null,
  })
})

test('베이스라인 창 안의 레코드로 실패율을 낸다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  b.push(rec(100, 'success'))
  b.push(rec(200, 'success'))
  b.push(rec(300, 'failure', 'timeout'))
  assert.equal(b.result().sampleCount, 4)
  assert.equal(b.result().failureRate, 0.25)
})

test('창을 넘어선 레코드는 반영하지 않는다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  b.push(rec(30_001, 'failure', 'timeout')) // 창 밖
  assert.equal(b.result().sampleCount, 1)
  assert.equal(b.result().failureRate, 0)
})

test('창 밖 레코드를 받으면 complete 가 된다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success'))
  assert.equal(b.result().complete, false)
  b.push(rec(30_001, 'success'))
  assert.equal(b.result().complete, true)
})

test('client 실패율을 따로 센다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'failure', 'client'))
  b.push(rec(100, 'failure', 'client'))
  b.push(rec(200, 'failure', 'timeout'))
  b.push(rec(300, 'success'))
  assert.equal(b.result().clientFailureRate, 0.5)
  assert.equal(b.result().failureRate, 0.75)
})

test('p95 는 응답을 받은 요청만으로 계산한다', () => {
  const b = createBaseline({ startTs: T0, baselineSec: 30 })
  b.push(rec(0, 'success', null, 100))
  b.push(rec(100, 'success', null, 200))
  // 타임아웃은 durationMs 가 null 이므로 p95 표본에 들어가지 않는다
  b.push(rec(200, 'failure', 'timeout', null))
  assert.equal(b.result().p95, 200)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/baseline.test.js`
Expected: FAIL — `Cannot find module '../src/analysis/baseline.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/analysis/baseline.js`:

```js
import { summarizeDurations } from './percentiles.js'

/**
 * 실행 시작 직후 구간을 평상시 기준값으로 잡는다.
 *
 * 노트북과 대상 사이 인터넷 구간 노이즈는 없앨 수 없으므로,
 * 절대값 대신 이 기준과의 델타로 읽게 하는 것이 목적이다.
 *
 * @param {{ startTs: number, baselineSec: number }} options
 */
export function createBaseline({ startTs, baselineSec }) {
  const windowEndTs = startTs + baselineSec * 1000
  let total = 0
  let failures = 0
  let clientFailures = 0
  let complete = false
  const durations = []

  return {
    push(record) {
      if (record.ts > windowEndTs) {
        // 창을 넘어섰다. 이후 레코드는 기준값에 반영하지 않는다.
        complete = true
        return
      }
      total += 1
      if (record.outcome === 'failure') {
        failures += 1
        if (record.failureType === 'client') clientFailures += 1
      }
      // 응답을 받은 요청만 지연 표본이 된다 (스펙 4.5)
      if (typeof record.durationMs === 'number') durations.push(record.durationMs)
    },

    result() {
      return {
        complete,
        sampleCount: total,
        failureRate: total > 0 ? failures / total : null,
        clientFailureRate: total > 0 ? clientFailures / total : null,
        p95: summarizeDurations(durations).p95,
      }
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/baseline.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: 커밋**

```bash
git add src/analysis/baseline.js test/baseline.test.js
git commit -m "feat: 배포 전 평상시 구간을 베이스라인으로 집계"
```

---

### Task 7: 1초 버킷 집계 (bucketer)

레코드를 1초 단위로 접어서 그래프에 보낼 형태로 만든다.

**Files:**
- Create: `src/analysis/bucketer.js`
- Test: `test/bucketer.test.js`

**Interfaces:**
- Consumes: `summarizeDurations` (Task 4), 레코드 형태
- Produces:
  - `createBucketer({ slowThresholdMs }) -> bucketer`
  - `bucketer.push(record) -> Bucket|null` — 초가 넘어가면 **직전에 완결된 버킷**을 반환한다
  - `bucketer.flush() -> Bucket|null` — 실행 종료 시 열려 있는 버킷을 닫는다
  - `Bucket`: `{ tsSec, sent, success, failure, byType, slow, p50, p95, p99, maxMs }`
    - `tsSec`: 버킷의 시작 초 (epoch 초)
    - `byType`: `{ network, timeout, server, client }`

**집계 규칙 (스펙 4.5):**

- `p50/p95/p99`, `maxMs`: **응답을 받은 요청만** (`durationMs` 가 숫자인 것). 타임아웃을 `timeoutMs` 로 쳐서 섞으면 p99가 타임아웃 설정값에 붙어버려 실제 지연이 안 보인다
- `slow`: **성공한 요청 중** `durationMs > slowThresholdMs` 인 건수. 실패한 요청이 느린 것은 이미 실패 건수에서 세고 있다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/bucketer.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBucketer } from '../src/analysis/bucketer.js'

let seq = 0
function rec(ts, outcome, { failureType = null, durationMs = 100 } = {}) {
  seq += 1
  return { seq, ts, status: null, durationMs, outcome, failureType, error: null }
}

test('같은 초의 레코드는 버킷을 닫지 않는다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  assert.equal(b.push(rec(1_000_000, 'success')), null)
  assert.equal(b.push(rec(1_000_500, 'success')), null)
})

test('초가 넘어가면 직전 버킷이 닫혀서 나온다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  b.push(rec(1_000_500, 'success'))
  const bucket = b.push(rec(1_001_000, 'success'))
  assert.ok(bucket)
  assert.equal(bucket.tsSec, 1000)
  assert.equal(bucket.sent, 2)
  assert.equal(bucket.success, 2)
})

test('성공과 실패를 나눠 센다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  b.push(rec(1_000_100, 'failure', { failureType: 'timeout', durationMs: null }))
  b.push(rec(1_000_200, 'failure', { failureType: 'network', durationMs: null }))
  const bucket = b.flush()
  assert.equal(bucket.sent, 3)
  assert.equal(bucket.success, 1)
  assert.equal(bucket.failure, 2)
  assert.deepEqual(bucket.byType, { network: 1, timeout: 1, server: 0, client: 0 })
})

test('백분위수는 응답을 받은 요청만으로 계산한다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 100 }))
  b.push(rec(1_000_100, 'failure', { failureType: 'server', durationMs: 300 }))
  // 타임아웃은 응답이 없으므로 표본에서 빠진다
  b.push(rec(1_000_200, 'failure', { failureType: 'timeout', durationMs: null }))
  const bucket = b.flush()
  assert.equal(bucket.maxMs, 300)
  assert.equal(bucket.p50, 100) // 표본 [100, 300] 의 nearest-rank p50 = ceil(0.5*2)-1 = 0번째
})

test('slow 는 성공한 요청만 센다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 1500 }))   // 느린 성공 -> 센다
  b.push(rec(1_000_100, 'success', { durationMs: 500 }))    // 빠른 성공 -> 안 센다
  b.push(rec(1_000_200, 'failure', { failureType: 'server', durationMs: 2000 })) // 실패 -> 안 센다
  assert.equal(b.flush().slow, 1)
})

test('임계값과 같은 값은 느린 것으로 치지 않는다', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success', { durationMs: 1000 }))
  assert.equal(b.flush().slow, 0)
})

test('레코드가 하나도 없으면 flush 는 null 이다', () => {
  assert.equal(createBucketer({ slowThresholdMs: 1000 }).flush(), null)
})

test('빈 초는 건너뛴다 (버킷을 만들지 않는다)', () => {
  const b = createBucketer({ slowThresholdMs: 1000 })
  b.push(rec(1_000_000, 'success'))
  const bucket = b.push(rec(1_005_000, 'success')) // 5초 뒤
  assert.equal(bucket.tsSec, 1000)
  // 사이의 빈 초에 대한 버킷은 만들지 않는다. 화면에서 공백으로 보이는 것이 맞다.
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/bucketer.test.js`
Expected: FAIL — `Cannot find module '../src/analysis/bucketer.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/analysis/bucketer.js`:

```js
import { summarizeDurations } from './percentiles.js'

/** 새 버킷 누적기를 만든다 */
function newAccumulator(tsSec) {
  return {
    tsSec,
    sent: 0,
    success: 0,
    failure: 0,
    byType: { network: 0, timeout: 0, server: 0, client: 0 },
    slow: 0,
    durations: [],
  }
}

/** 누적기를 전송용 버킷으로 확정한다 */
function seal(acc) {
  const { p50, p95, p99, max } = summarizeDurations(acc.durations)
  return {
    tsSec: acc.tsSec,
    sent: acc.sent,
    success: acc.success,
    failure: acc.failure,
    byType: acc.byType,
    slow: acc.slow,
    p50, p95, p99,
    maxMs: max,
  }
}

/**
 * 레코드를 1초 단위로 접는다.
 *
 * @param {{ slowThresholdMs: number }} options
 */
export function createBucketer({ slowThresholdMs }) {
  let acc = null

  function add(record) {
    acc.sent += 1
    if (record.outcome === 'success') {
      acc.success += 1
      // slow 가 답해야 하는 질문은 "성공은 했는데 사용자가 기다렸는가" 다.
      // 실패한 요청이 느린 것은 이미 실패 건수에서 세고 있다.
      if (typeof record.durationMs === 'number' && record.durationMs > slowThresholdMs) {
        acc.slow += 1
      }
    } else {
      acc.failure += 1
      if (record.failureType in acc.byType) acc.byType[record.failureType] += 1
    }
    // 응답을 받은 요청만 지연 표본이 된다 (스펙 4.5)
    if (typeof record.durationMs === 'number') acc.durations.push(record.durationMs)
  }

  return {
    push(record) {
      const tsSec = Math.floor(record.ts / 1000)

      if (acc === null) {
        acc = newAccumulator(tsSec)
        add(record)
        return null
      }

      if (tsSec === acc.tsSec) {
        add(record)
        return null
      }

      // 초가 넘어갔다. 직전 버킷을 닫고 새로 시작한다.
      // 사이에 빈 초가 있어도 버킷을 만들지 않는다 — 화면에서 공백으로 보이는 것이 맞다.
      const sealed = seal(acc)
      acc = newAccumulator(tsSec)
      add(record)
      return sealed
    },

    flush() {
      if (acc === null) return null
      const sealed = seal(acc)
      acc = null
      return sealed
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/bucketer.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: 커밋**

```bash
git add src/analysis/bucketer.js test/bucketer.test.js
git commit -m "feat: 레코드를 1초 버킷으로 집계"
```

---

### Task 8: 고정 레이트 발사기 (scheduler)

스펙 4.1의 coordinated omission 회피가 여기서 구현된다. **응답을 기다린 뒤 다음 요청을 보내면 안 된다.** 대상이 배포 중 죽어 응답이 없을 때 요청 속도가 같이 죽어버리면, 정작 측정해야 할 구간의 표본이 사라진다.

**Files:**
- Create: `src/prober/scheduler.js`
- Test: `test/scheduler.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `createScheduler({ intervalMs, maxInFlight }) -> scheduler`
  - `scheduler.start(onFire) -> void` — `onFire(seq)` 는 Promise를 반환해야 한다. 스케줄러가 그 Promise로 in-flight 수를 센다
  - `scheduler.stop() -> void`
  - `scheduler.stats() -> { fired, dropped, inFlight }`

**규칙:**

- 발사 간격은 `intervalMs`. in-flight 여부와 무관하게 절대 시각 기준으로 슬롯을 잡는다 (드리프트 누적 방지)
- in-flight 가 `maxInFlight` 이상이면 그 슬롯은 발사하지 않고 `dropped` 를 올린다
- 이벤트 루프가 밀려서 슬롯을 놓쳤으면, 몰아서 쏘지 않고 놓친 슬롯 수만큼 `dropped` 를 올린다. 한꺼번에 터뜨리면 그 순간의 측정이 왜곡된다
- `seq` 는 **실제로 발사한 요청에만** 1부터 순서대로 붙인다. 버린 슬롯은 `seq` 를 소비하지 않는다 (Task 9가 `seq` 의 연속성에 의존한다)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/scheduler.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/prober/scheduler.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 영원히 끝나지 않는 요청 — 대상이 죽어 응답이 없는 상황을 흉내낸다 */
const never = () => new Promise(() => {})

test('응답이 오지 않아도 발사 간격이 유지된다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(never)
  await sleep(200)
  s.stop()
  // 200ms / 10ms = 20슬롯. 타이머 오차를 감안해 넉넉히 잡는다.
  assert.ok(s.stats().fired >= 12, `발사 ${s.stats().fired}건은 너무 적다`)
  assert.equal(s.stats().dropped, 0)
})

test('in-flight 상한에 걸리면 dropped 가 올라간다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 3 })
  s.start(never)
  await sleep(200)
  s.stop()
  assert.equal(s.stats().fired, 3, 'in-flight 상한까지만 발사해야 한다')
  assert.ok(s.stats().dropped > 0, '나머지 슬롯은 dropped 로 세야 한다')
})

test('요청이 끝나면 in-flight 가 줄어 다시 발사된다', async () => {
  let resolvers = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 2 })
  s.start(() => new Promise((resolve) => resolvers.push(resolve)))
  await sleep(60)
  assert.equal(s.stats().fired, 2)

  resolvers.forEach((r) => r())
  resolvers = []
  await sleep(60)
  s.stop()
  assert.ok(s.stats().fired > 2, '완료 후에는 다시 발사돼야 한다')
})

test('seq 는 1부터 순서대로 붙는다', async () => {
  const seen = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async (seq) => { seen.push(seq) })
  await sleep(80)
  s.stop()
  assert.equal(seen[0], 1)
  assert.deepEqual(seen, seen.map((_, i) => i + 1))
})

test('버린 슬롯은 seq 를 소비하지 않는다', async () => {
  const seen = []
  const s = createScheduler({ intervalMs: 10, maxInFlight: 2 })
  s.start(async (seq) => { seen.push(seq); await never() })
  await sleep(150)
  s.stop()
  // dropped 가 많아도 실제 발사된 두 건의 seq 는 1, 2 여야 한다
  assert.deepEqual(seen, [1, 2])
  assert.ok(s.stats().dropped > 0)
})

test('stop 이후에는 더 발사하지 않는다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async () => {})
  await sleep(50)
  s.stop()
  const after = s.stats().fired
  await sleep(60)
  assert.equal(s.stats().fired, after)
})

test('onFire 가 예외를 던져도 스케줄러는 계속 돈다', async () => {
  const s = createScheduler({ intervalMs: 10, maxInFlight: 1000 })
  s.start(async () => { throw new Error('boom') })
  await sleep(80)
  s.stop()
  assert.ok(s.stats().fired >= 3)
  assert.equal(s.stats().inFlight, 0, '예외가 나도 in-flight 는 해제돼야 한다')
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/scheduler.test.js`
Expected: FAIL — `Cannot find module '../src/prober/scheduler.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/prober/scheduler.js`:

```js
/**
 * 고정 레이트로 발사 신호를 낸다.
 *
 * 응답을 기다린 뒤 다음을 쏘면, 대상이 죽어 응답이 없는 구간에서
 * 요청 속도도 같이 죽는다. 유실을 재는 도구가 유실 구간에서 눈을 감는 셈이다.
 * 그래서 in-flight 여부와 무관하게 절대 시각 기준으로 슬롯을 잡는다.
 *
 * @param {{ intervalMs: number, maxInFlight: number }} options
 */
export function createScheduler({ intervalMs, maxInFlight }) {
  let running = false
  let timer = null
  let startedAt = 0
  let slot = 0
  let seq = 0
  let fired = 0
  let dropped = 0
  let inFlight = 0

  function fire(onFire) {
    seq += 1
    fired += 1
    inFlight += 1
    // onFire 가 동기적으로 던지는 경우까지 감싼다
    Promise.resolve()
      .then(() => onFire(seq))
      .catch(() => {})
      .finally(() => { inFlight -= 1 })
  }

  function loop(onFire) {
    if (!running) return

    let target = startedAt + slot * intervalMs
    const now = Date.now()

    if (now - target > intervalMs) {
      // 이벤트 루프가 밀렸다. 놓친 슬롯을 몰아서 쏘면 그 순간의 측정이 왜곡되므로,
      // 발사하지 않고 버린 것으로 센다.
      const missed = Math.floor((now - target) / intervalMs)
      dropped += missed
      slot += missed
      target = startedAt + slot * intervalMs
    }

    timer = setTimeout(() => {
      if (!running) return
      if (inFlight >= maxInFlight) {
        dropped += 1
      } else {
        fire(onFire)
      }
      slot += 1
      loop(onFire)
    }, Math.max(0, target - Date.now()))
  }

  return {
    /** @param {(seq: number) => Promise<void>} onFire */
    start(onFire) {
      if (running) return
      running = true
      startedAt = Date.now()
      slot = 0
      loop(onFire)
    },

    stop() {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },

    stats() {
      return { fired, dropped, inFlight }
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/scheduler.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: 커밋**

```bash
git add src/prober/scheduler.js test/scheduler.test.js
git commit -m "feat: in-flight와 무관하게 고정 레이트로 발사하는 스케줄러"
```

---

### Task 9: 레코드 순서 복원 (sequence-buffer)

**이 태스크가 없으면 순단 감지가 통째로 틀린다.** 왜 필요한지부터 읽을 것.

요청은 발사 순서대로 나가지만 **완료 순서는 뒤집힌다.** 배포 중 상황을 그려보면:

| 요청 | 발사 | 완료 | 결과 |
|---|---|---|---|
| A | t=0.00초 | t=5.00초 | 타임아웃 |
| B | t=0.05초 | t=5.05초 | 타임아웃 |
| C | t=3.10초 | t=3.15초 | 성공 (대상 복구됨) |

완료 순서대로 detector에 넣으면 `C(성공) → A(실패) → B(실패)` 가 된다. 연속 실패 구간이 성공으로 잘려버려서 순단이 아예 안 잡히거나 엉뚱한 위치에 잡힌다.

그래서 레코드를 **발사 순서(`seq`)대로 재정렬한 뒤** 분석 단위에 넣는다. Task 8이 발사한 요청에만 `seq` 를 빈틈없이 1부터 붙이므로, 시간 창이 아니라 `seq` 연속성만으로 정확하게 복원할 수 있다.

**Files:**
- Create: `src/prober/sequence-buffer.js`
- Test: `test/sequence-buffer.test.js`

**Interfaces:**
- Consumes: 레코드 형태 (`seq` 는 1부터 연속)
- Produces:
  - `createSequenceBuffer({ firstSeq = 1 }) -> buffer`
  - `buffer.push(record) -> Record[]` — 순서가 맞춰져 내보낼 수 있게 된 레코드들. 아직이면 빈 배열
  - `buffer.flush() -> Record[]` — 남은 것 전부를 `seq` 오름차순으로. 구멍이 있어도 낸다
  - `buffer.pending() -> number` — 아직 붙잡고 있는 레코드 수

- [ ] **Step 1: 실패하는 테스트 작성**

`test/sequence-buffer.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSequenceBuffer } from '../src/prober/sequence-buffer.js'

const r = (seq) => ({ seq, ts: 1000 + seq, outcome: 'success', failureType: null, status: 200, durationMs: 10, error: null })
const seqs = (records) => records.map((x) => x.seq)

test('순서대로 들어오면 즉시 나온다', () => {
  const b = createSequenceBuffer({})
  assert.deepEqual(seqs(b.push(r(1))), [1])
  assert.deepEqual(seqs(b.push(r(2))), [2])
})

test('앞선 레코드가 아직 안 왔으면 붙잡고 있는다', () => {
  const b = createSequenceBuffer({})
  assert.deepEqual(b.push(r(3)), [])
  assert.deepEqual(b.push(r(2)), [])
  assert.equal(b.pending(), 2)
})

test('빠진 레코드가 도착하면 밀려 있던 것이 한꺼번에 나온다', () => {
  const b = createSequenceBuffer({})
  b.push(r(3))
  b.push(r(2))
  assert.deepEqual(seqs(b.push(r(1))), [1, 2, 3])
  assert.equal(b.pending(), 0)
})

test('배포 중 뒤집힌 완료 순서를 발사 순서로 되돌린다', () => {
  const b = createSequenceBuffer({})
  const out = []
  // C(성공)가 A, B(타임아웃)보다 먼저 완료된 상황
  out.push(...b.push({ ...r(3), outcome: 'success' }))
  out.push(...b.push({ ...r(1), outcome: 'failure', failureType: 'timeout' }))
  out.push(...b.push({ ...r(2), outcome: 'failure', failureType: 'timeout' }))
  assert.deepEqual(seqs(out), [1, 2, 3])
  assert.deepEqual(out.map((x) => x.outcome), ['failure', 'failure', 'success'])
})

test('flush 는 구멍이 있어도 남은 것을 순서대로 낸다', () => {
  const b = createSequenceBuffer({})
  b.push(r(2))
  b.push(r(5))
  b.push(r(4))
  assert.deepEqual(seqs(b.flush()), [2, 4, 5])
  assert.equal(b.pending(), 0)
})

test('flush 이후에도 계속 쓸 수 있다', () => {
  const b = createSequenceBuffer({})
  b.push(r(2))
  b.flush()
  // flush 는 nextSeq 를 마지막으로 내보낸 seq 다음으로 옮긴다.
  // 그 자리에서 이어지는 레코드는 곧바로 나와야 한다.
  assert.deepEqual(seqs(b.push(r(3))), [3])
})

test('firstSeq 를 지정할 수 있다', () => {
  const b = createSequenceBuffer({ firstSeq: 10 })
  assert.deepEqual(b.push(r(11)), [])
  assert.deepEqual(seqs(b.push(r(10))), [10, 11])
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/sequence-buffer.test.js`
Expected: FAIL — `Cannot find module '../src/prober/sequence-buffer.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/prober/sequence-buffer.js`:

```js
/**
 * 완료 순서로 도착한 레코드를 발사 순서(seq)로 되돌린다.
 *
 * 타임아웃된 요청은 나중에 발사된 성공 요청보다 늦게 완료된다.
 * 그 순서 그대로 순단 감지에 넣으면 연속 실패 구간이 성공으로 잘려
 * 순단이 아예 안 잡힌다. 그래서 여기서 순서를 복원한 뒤 분석에 넘긴다.
 *
 * 스케줄러가 발사한 요청에만 seq 를 빈틈없이 붙이므로,
 * 시간 창이 아니라 seq 연속성만으로 정확하게 복원할 수 있다.
 *
 * @param {{ firstSeq?: number }} options
 */
export function createSequenceBuffer({ firstSeq = 1 } = {}) {
  let nextSeq = firstSeq
  /** @type {Map<number, object>} */
  const held = new Map()

  return {
    /**
     * @param {object} record
     * @returns {object[]} 지금 내보낼 수 있게 된 레코드들 (발사 순서)
     */
    push(record) {
      held.set(record.seq, record)

      const ready = []
      while (held.has(nextSeq)) {
        ready.push(held.get(nextSeq))
        held.delete(nextSeq)
        nextSeq += 1
      }
      return ready
    },

    /**
     * 실행이 끝났다. 구멍이 있어도 남은 것을 순서대로 전부 낸다.
     * @returns {object[]}
     */
    flush() {
      const rest = [...held.values()].sort((a, b) => a.seq - b.seq)
      held.clear()
      if (rest.length > 0) nextSeq = rest[rest.length - 1].seq + 1
      return rest
    },

    pending() {
      return held.size
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/sequence-buffer.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: 커밋**

```bash
git add src/prober/sequence-buffer.js test/sequence-buffer.test.js
git commit -m "feat: 완료 순서로 도착한 레코드를 발사 순서로 복원"
```

---

### Task 10: 프로버 (Prober 인터페이스와 내부 구현)

앞의 조각들을 엮어 실제로 요청을 쏘고 레코드를 뱉는다. **이 인터페이스가 나중에 k6를 붙일 수 있게 하는 유일한 장치다.**

**Files:**
- Create: `src/prober/index.js`
- Create: `src/prober/internal-prober.js`
- Test: `test/internal-prober.test.js`

**Interfaces:**
- Consumes: `classify` (Task 2), `renderTemplate`/`renderHeaders` (Task 3), `createScheduler` (Task 8), `createSequenceBuffer` (Task 9)
- Produces:
  - `src/prober/index.js`: `createProber(kind, deps) -> Prober` — 현재 `kind` 는 `'internal'` 하나뿐. `K6Prober` 는 지금 만들지 않는다
  - `Prober.start(scenario, onRecord) -> Promise<{ fired, dropped }>` — 실행이 끝나면 resolve. `onRecord(record)` 는 **발사 순서대로** 호출된다
  - `Prober.stop() -> void`

**동작:**

1. `intervalMs = 1000 / scenario.load.rps`
2. `maxInFlight = Math.ceil(rps * (timeoutMs / 1000) * 2)` (스펙 4.1)
3. 매 발사마다 `AbortController` 로 `timeoutMs` 타임아웃을 건다
4. `ts` 는 **발사 시각**이다. 완료 시각이 아니다 (Task 9 참고)
5. `durationMs` 는 응답을 받은 경우에만 숫자다. 타임아웃·네트워크 실패는 `null`
6. `durationSec` 이 지나면 스케줄러를 멈추고, in-flight 가 전부 정리될 때까지 기다린 뒤 resolve

- [ ] **Step 1: 실패하는 테스트 작성**

`test/internal-prober.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createProber } from '../src/prober/index.js'

/** 핸들러를 바꿔 끼울 수 있는 테스트 서버를 띄운다 */
async function startServer(handler) {
  const state = { handler }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => state.handler(req, res, body))
  })
  server.listen(0)
  await new Promise((r) => server.once('listening', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/signup`,
    setHandler: (h) => { state.handler = h },
    close: () => new Promise((r) => server.close(r)),
  }
}

function scenarioFor(url, overrides = {}) {
  return {
    name: '테스트',
    target: {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local","nickname":"u{{counter}}"}',
      timeoutMs: 1000,
      ...overrides.target,
    },
    success: { statusCodes: [200, 201] },
    load: { rps: 20, durationSec: 1, ...overrides.load },
    analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
  }
}

test('성공 응답을 성공 레코드로 만든다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const records = []
    const prober = createProber('internal')
    const stats = await prober.start(scenarioFor(server.url), (r) => records.push(r))

    assert.ok(records.length >= 10, `레코드 ${records.length}건은 너무 적다`)
    assert.ok(records.every((r) => r.outcome === 'success'))
    assert.ok(records.every((r) => r.status === 201))
    assert.ok(records.every((r) => typeof r.durationMs === 'number'))
    assert.equal(stats.dropped, 0)
  } finally {
    await server.close()
  }
})

test('레코드는 발사 순서대로 전달된다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const records = []
    await createProber('internal').start(scenarioFor(server.url), (r) => records.push(r))
    assert.deepEqual(records.map((r) => r.seq), records.map((_, i) => i + 1))
  } finally {
    await server.close()
  }
})

test('플레이스홀더가 요청마다 다른 값으로 치환된다', async () => {
  const seen = []
  const server = await startServer((req, res, body) => {
    seen.push(JSON.parse(body))
    res.writeHead(201); res.end('{}')
  })
  try {
    await createProber('internal').start(scenarioFor(server.url), () => {})
    const emails = new Set(seen.map((b) => b.email))
    assert.equal(emails.size, seen.length, '이메일이 중복되면 안 된다')
    assert.equal(seen[0].nickname, 'u1')
  } finally {
    await server.close()
  }
})

test('5xx 는 server 실패로 기록된다', async () => {
  const server = await startServer((req, res) => { res.writeHead(503); res.end('') })
  try {
    const records = []
    await createProber('internal').start(scenarioFor(server.url), (r) => records.push(r))
    assert.ok(records.every((r) => r.failureType === 'server'))
  } finally {
    await server.close()
  }
})

test('응답하지 않는 서버는 timeout 실패가 되고 durationMs 는 null 이다', async () => {
  const server = await startServer(() => { /* 영원히 응답하지 않는다 */ })
  try {
    const records = []
    const s = scenarioFor(server.url, { target: { timeoutMs: 200 }, load: { rps: 10, durationSec: 1 } })
    await createProber('internal').start(s, (r) => records.push(r))
    assert.ok(records.length > 0)
    assert.ok(records.every((r) => r.failureType === 'timeout'))
    assert.ok(records.every((r) => r.durationMs === null))
  } finally {
    await server.close()
  }
})

test('닿지 않는 주소는 network 실패가 된다', async () => {
  const records = []
  // 127.0.0.1 의 닫힌 포트 -> ECONNREFUSED
  const s = scenarioFor('http://127.0.0.1:9/signup', { load: { rps: 10, durationSec: 1 } })
  await createProber('internal').start(s, (r) => records.push(r))
  assert.ok(records.length > 0)
  assert.ok(records.every((r) => r.failureType === 'network'))
})

test('stop 을 부르면 일찍 끝난다', async () => {
  const server = await startServer((req, res) => { res.writeHead(201); res.end('{}') })
  try {
    const prober = createProber('internal')
    const started = Date.now()
    const promise = prober.start(scenarioFor(server.url, { load: { rps: 20, durationSec: 60 } }), () => {})
    setTimeout(() => prober.stop(), 300)
    await promise
    assert.ok(Date.now() - started < 3000, '60초를 기다리면 안 된다')
  } finally {
    await server.close()
  }
})

test('알 수 없는 프로버 종류는 예외를 던진다', () => {
  assert.throws(() => createProber('k6'), /알 수 없는 프로버/)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/internal-prober.test.js`
Expected: FAIL — `Cannot find module '../src/prober/index.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/prober/index.js`:

```js
import { createInternalProber } from './internal-prober.js'

/**
 * Prober: 시나리오를 받아 요청 레코드를 흘려보내는 것.
 *
 *   start(scenario, onRecord) -> Promise<{ fired, dropped }>
 *   stop() -> void
 *
 * onRecord 는 발사 순서(seq 오름차순)대로 호출된다.
 *
 * 레코드 형태:
 *   { seq, ts, status, durationMs, outcome, failureType, error }
 *
 * 이 경계 덕분에 집계·순단 감지·화면은 "누가 요청을 쐈는지" 를 알지 못한다.
 * 나중에 k6 서브프로세스의 출력을 같은 레코드로 변환하는 K6Prober 를 추가해도
 * 그 아래쪽은 한 줄도 바뀌지 않는다.
 *
 * @param {'internal'} kind
 * @param {object} deps 테스트에서 fetch 를 주입할 때 쓴다
 */
export function createProber(kind = 'internal', deps = {}) {
  if (kind === 'internal') return createInternalProber(deps)
  throw new Error(`알 수 없는 프로버 종류입니다: ${kind}`)
}
```

`src/prober/internal-prober.js`:

```js
import { classify } from './classify.js'
import { renderTemplate, renderHeaders } from './request-template.js'
import { createScheduler } from './scheduler.js'
import { createSequenceBuffer } from './sequence-buffer.js'

/**
 * Node 가 직접 요청을 쏘는 프로버.
 *
 * @param {{ fetchImpl?: typeof fetch }} deps
 */
export function createInternalProber({ fetchImpl = fetch } = {}) {
  let scheduler = null
  let stopRequested = false
  let resolveDone = null

  /** 요청 1건을 보내고 결과를 분류 가능한 형태로 돌려준다 */
  async function sendOnce(scenario, seq) {
    const now = Date.now()
    const ctx = { counter: seq, now }
    const { url, method, headers, body, timeoutMs } = scenario.target

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()

    try {
      const res = await fetchImpl(url, {
        method,
        headers: renderHeaders(headers, ctx),
        // GET/HEAD 에는 바디를 붙이지 않는다
        body: method === 'GET' || method === 'HEAD' ? undefined : renderTemplate(body ?? '', ctx),
        signal: controller.signal,
        redirect: 'manual', // 3xx 를 따라가지 않는다 (스펙 8장)
      })
      // 커넥션을 반납하려면 본문을 소비해야 한다
      await res.arrayBuffer().catch(() => {})
      return { status: res.status, durationMs: Date.now() - startedAt, error: null }
    } catch (err) {
      if (controller.signal.aborted) {
        return { timedOut: true, durationMs: null, error: 'timeout' }
      }
      return {
        errorCode: err?.cause?.code ?? err?.code ?? 'UNKNOWN',
        durationMs: null,
        error: String(err?.cause?.code ?? err?.message ?? err),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 스케줄러를 멈추라고 표시한다. 남은 in-flight 는 각자 끝나기를 기다린다. */
  function requestStop() {
    stopRequested = true
    if (scheduler !== null) scheduler.stop()
  }

  return {
    async start(scenario, onRecord) {
      stopRequested = false
      const { rps, durationSec } = scenario.load
      const { timeoutMs } = scenario.target
      const successCodes = scenario.success.statusCodes

      const buffer = createSequenceBuffer({ firstSeq: 1 })
      /** 발사 시각을 seq 별로 기억해 둔다 (레코드의 ts 로 쓴다) */
      const firedAt = new Map()

      scheduler = createScheduler({
        intervalMs: 1000 / rps,
        maxInFlight: Math.ceil(rps * (timeoutMs / 1000) * 2),
      })

      const done = new Promise((resolve) => { resolveDone = resolve })

      scheduler.start(async (seq) => {
        firedAt.set(seq, Date.now())
        const result = await sendOnce(scenario, seq)
        const { outcome, failureType } = classify(result, successCodes)

        const record = {
          seq,
          ts: firedAt.get(seq),
          status: typeof result.status === 'number' ? result.status : null,
          durationMs: result.durationMs,
          outcome,
          failureType,
          error: result.error ?? null,
        }
        firedAt.delete(seq)

        // 완료 순서가 아니라 발사 순서로 내보낸다
        for (const ordered of buffer.push(record)) onRecord(ordered)
      })

      const durationTimer = setTimeout(requestStop, durationSec * 1000)

      /** 스케줄러를 멈춘 뒤 in-flight 가 정리될 때까지 기다린다 */
      const waitIdle = setInterval(() => {
        if (!stopRequested) return
        if (scheduler.stats().inFlight > 0) return
        clearInterval(waitIdle)
        clearTimeout(durationTimer)
        for (const ordered of buffer.flush()) onRecord(ordered)
        resolveDone({ fired: scheduler.stats().fired, dropped: scheduler.stats().dropped })
      }, 20)

      return done
    },

    stop: requestStop,
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/internal-prober.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: 커밋**

```bash
git add src/prober/index.js src/prober/internal-prober.js test/internal-prober.test.js
git commit -m "feat: Prober 인터페이스와 내부 구현"
```

---

### Task 11: 실행 오케스트레이션 (run, run-store)

프로버가 뱉는 레코드를 집계 단위들에 흘려보내고, 이벤트로 밖에 알린다. 자동 중단과 경고 판정도 여기서 한다.

**Files:**
- Create: `src/run/run.js`
- Create: `src/run/run-store.js`
- Test: `test/run.test.js`
- Test: `test/run-store.test.js`

**Interfaces:**
- Consumes: `createBucketer` (T7), `createOutageDetector` (T5), `createBaseline` (T6), `summarizeDurations` (T4), Prober (T10)
- Produces:
  - `createRun({ scenario, prober }) -> run`
    - `run.id: string`, `run.scenario`, `run.status`, `run.startedAt`, `run.finishedAt`
    - `run.on(event, cb) -> () => void` — `'bucket' | 'outage' | 'summary' | 'state'`
    - `run.start() -> Promise<void>`
    - `run.stop() -> void`
    - `run.summary() -> Summary`
    - `run.buckets() -> Bucket[]` — SSE 재연결 시 재전송용
  - `createRunStore({ max = 10 }) -> store`
    - `store.add(run)`, `store.get(id)`, `store.list()`, `store.active()`

**Summary 형태:**

```js
{
  runId, status, startedAt, finishedAt,
  totals: { sent, success, failure, byType, slow, dropped },
  percentiles: { p50, p95, p99, max, count },
  baseline: { complete, sampleCount, failureRate, clientFailureRate, p95 },
  outages: [...],
  downtimeMs,
  warnings: [...],
}
```

**판정 규칙:**

- 베이스라인 시작 시각은 `Date.now()` 가 아니라 **첫 레코드의 `ts`** 다. 실제로 요청이 나가기 시작한 시점이 기준이어야 한다
- 자동 중단 (스펙 8장): 성공이 **한 건도 없는** 상태에서 첫 10건이 전부 `network` 실패면 중단하고 `status = 'unreachable'`. 한 번이라도 성공한 뒤의 연속 실패는 순단이므로 이 규칙을 적용하지 않는다
- 경고 (`warnings`):
  - `dropped` — `totals.dropped > 0`. 그 실행의 수치는 신뢰할 수 없다
  - `baseline-unstable` — 베이스라인 구간 실패율 > 5%
  - `client-heavy` — 베이스라인 구간 `client` 실패율 > 50%. 폼 설정을 의심해야 한다
  - `unreachable` — 자동 중단됨
- `summary` 이벤트는 5초마다, 그리고 종료 시점에 보낸다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/run.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRun } from '../src/run/run.js'

const T0 = 1_700_000_000_000

function rec(seq, offsetMs, outcome, { failureType = null, durationMs = 50 } = {}) {
  return {
    seq, ts: T0 + offsetMs, status: outcome === 'success' ? 200 : 500,
    durationMs, outcome, failureType, error: null,
  }
}

/** 미리 정해둔 레코드를 그대로 흘려보내는 가짜 프로버 */
function fakeProber(records, { dropped = 0 } = {}) {
  const state = { stopped: false, delivered: 0 }
  return {
    state,
    async start(scenario, onRecord) {
      for (const r of records) {
        if (state.stopped) break
        state.delivered += 1
        onRecord(r)
      }
      return { fired: state.delivered, dropped }
    },
    stop() { state.stopped = true },
  }
}

const scenario = {
  name: '테스트',
  target: { url: 'http://x/y', method: 'POST', headers: {}, body: '{}', timeoutMs: 1000 },
  success: { statusCodes: [200] },
  load: { rps: 20, durationSec: 10 },
  analysis: { slowThresholdMs: 1000, baselineSec: 30, minConsecutiveFailures: 3 },
}

test('레코드를 집계해 총계를 낸다', async () => {
  const records = [
    rec(1, 0, 'success'),
    rec(2, 100, 'success'),
    rec(3, 200, 'failure', { failureType: 'server', durationMs: 20 }),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()

  const s = run.summary()
  assert.equal(s.totals.sent, 3)
  assert.equal(s.totals.success, 2)
  assert.equal(s.totals.failure, 1)
  assert.equal(s.totals.byType.server, 1)
  assert.equal(s.status, 'finished')
})

test('초가 넘어가면 bucket 이벤트가 나온다', async () => {
  const records = [rec(1, 0, 'success'), rec(2, 1500, 'success'), rec(3, 2500, 'success')]
  const seen = []
  const run = createRun({ scenario, prober: fakeProber(records) })
  run.on('bucket', (b) => seen.push(b))
  await run.start()
  assert.ok(seen.length >= 2, `버킷 ${seen.length}개는 너무 적다`)
  assert.equal(run.buckets().length, seen.length)
})

test('순단이 감지되면 outage 이벤트와 다운타임이 나온다', async () => {
  const records = [
    rec(1, 0, 'success'),
    rec(2, 1000, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(3, 1050, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(4, 1100, 'failure', { failureType: 'timeout', durationMs: null }),
    rec(5, 4000, 'success'),
  ]
  const seen = []
  const run = createRun({ scenario, prober: fakeProber(records) })
  run.on('outage', (o) => seen.push(o))
  await run.start()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].durationMs, 4000)
  assert.equal(run.summary().downtimeMs, 4000)
})

test('성공 없이 network 실패 10건이면 자동 중단된다', async () => {
  const records = Array.from({ length: 30 }, (_, i) =>
    rec(i + 1, i * 50, 'failure', { failureType: 'network', durationMs: null }))
  const prober = fakeProber(records)
  const run = createRun({ scenario, prober })
  await run.start()

  assert.equal(run.status, 'unreachable')
  assert.ok(prober.state.stopped, '프로버를 멈춰야 한다')
  assert.ok(prober.state.delivered < 30, '30건을 다 소비하면 안 된다')
  assert.ok(run.summary().warnings.includes('unreachable'))
})

test('한 번 성공한 뒤의 연속 실패는 자동 중단하지 않는다', async () => {
  const records = [
    rec(1, 0, 'success'),
    ...Array.from({ length: 20 }, (_, i) =>
      rec(i + 2, (i + 1) * 50, 'failure', { failureType: 'network', durationMs: null })),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.equal(run.status, 'finished')
})

test('dropped 가 있으면 경고가 붙는다', async () => {
  const run = createRun({ scenario, prober: fakeProber([rec(1, 0, 'success')], { dropped: 4 }) })
  await run.start()
  assert.equal(run.summary().totals.dropped, 4)
  assert.ok(run.summary().warnings.includes('dropped'))
})

test('베이스라인 실패율이 5%를 넘으면 경고가 붙는다', async () => {
  // 베이스라인 창(30초) 안에서 10건 중 2건 실패 = 20%
  const records = [
    ...Array.from({ length: 8 }, (_, i) => rec(i + 1, i * 100, 'success')),
    rec(9, 900, 'failure', { failureType: 'server', durationMs: 10 }),
    rec(10, 1000, 'failure', { failureType: 'server', durationMs: 10 }),
    rec(11, 31_000, 'success'), // 창 밖 -> complete 로 만든다
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.ok(run.summary().warnings.includes('baseline-unstable'))
})

test('베이스라인 client 실패가 절반을 넘으면 경고가 붙는다', async () => {
  const records = [
    ...Array.from({ length: 6 }, (_, i) => rec(i + 1, i * 100, 'failure', { failureType: 'client', durationMs: 10 })),
    ...Array.from({ length: 4 }, (_, i) => rec(i + 7, 700 + i * 100, 'success')),
    rec(11, 31_000, 'success'),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.ok(run.summary().warnings.includes('client-heavy'))
})

test('state 이벤트로 상태 변화를 알린다', async () => {
  const seen = []
  const run = createRun({ scenario, prober: fakeProber([rec(1, 0, 'success')]) })
  run.on('state', (s) => seen.push(s.status))
  await run.start()
  assert.deepEqual(seen, ['running', 'finished'])
})

test('백분위수는 응답을 받은 요청만으로 계산한다', async () => {
  const records = [
    rec(1, 0, 'success', { durationMs: 100 }),
    rec(2, 100, 'success', { durationMs: 300 }),
    rec(3, 200, 'failure', { failureType: 'timeout', durationMs: null }),
  ]
  const run = createRun({ scenario, prober: fakeProber(records) })
  await run.start()
  assert.equal(run.summary().percentiles.count, 2)
  assert.equal(run.summary().percentiles.max, 300)
})
```

`test/run-store.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunStore } from '../src/run/run-store.js'

const fakeRun = (id, status = 'finished') => ({ id, status, startedAt: Date.now() })

test('넣은 실행을 id 로 꺼낸다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a'))
  assert.equal(store.get('a').id, 'a')
})

test('없는 id 는 undefined 다', () => {
  assert.equal(createRunStore({ max: 10 }).get('없음'), undefined)
})

test('최신순으로 나열한다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a')); store.add(fakeRun('b'))
  assert.deepEqual(store.list().map((r) => r.id), ['b', 'a'])
})

test('max 를 넘으면 오래된 것부터 버린다', () => {
  const store = createRunStore({ max: 3 })
  for (const id of ['a', 'b', 'c', 'd']) store.add(fakeRun(id))
  assert.deepEqual(store.list().map((r) => r.id), ['d', 'c', 'b'])
  assert.equal(store.get('a'), undefined)
})

test('running 상태인 실행을 active 로 찾는다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a', 'finished'))
  store.add(fakeRun('b', 'running'))
  assert.equal(store.active().id, 'b')
})

test('running 이 없으면 active 는 undefined 다', () => {
  const store = createRunStore({ max: 10 })
  store.add(fakeRun('a', 'finished'))
  assert.equal(store.active(), undefined)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/run.test.js test/run-store.test.js`
Expected: FAIL — `Cannot find module '../src/run/run.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/run/run.js`:

```js
import { randomUUID } from 'node:crypto'
import { createBucketer } from '../analysis/bucketer.js'
import { createOutageDetector } from '../analysis/outage-detector.js'
import { createBaseline } from '../analysis/baseline.js'
import { summarizeDurations } from '../analysis/percentiles.js'

const SUMMARY_INTERVAL_MS = 5000
/** 성공이 한 건도 없는 상태에서 이만큼 network 실패가 이어지면 대상에 닿지 않는 것으로 본다 */
const UNREACHABLE_STREAK = 10

/**
 * 프로버가 뱉는 레코드를 집계 단위들에 흘려보내고 이벤트로 알린다.
 *
 * @param {{ scenario: object, prober: object }} options
 */
export function createRun({ scenario, prober }) {
  const id = randomUUID()
  const listeners = { bucket: [], outage: [], summary: [], state: [] }

  const bucketer = createBucketer({ slowThresholdMs: scenario.analysis.slowThresholdMs })
  const detector = createOutageDetector({ minConsecutiveFailures: scenario.analysis.minConsecutiveFailures })
  /** 베이스라인은 첫 레코드가 와야 시작 시각을 안다 */
  let baseline = null

  const buckets = []
  const durations = []
  const totals = {
    sent: 0, success: 0, failure: 0,
    byType: { network: 0, timeout: 0, server: 0, client: 0 },
    slow: 0, dropped: 0,
  }

  let status = 'idle'
  let startedAt = null
  let finishedAt = null
  let sawSuccess = false
  let networkStreak = 0
  let summaryTimer = null

  function emit(event, payload) {
    // 사본을 순회한다. 리스너가 자기 자신이나 다른 리스너를 해제하면
    // 원본 배열이 순회 도중 줄어들어 다음 리스너를 건너뛴다.
    // SSE 핸들러가 실제로 state 리스너 안에서 구독을 전부 해제하므로
    // 뷰어가 둘 이상일 때 한쪽이 마지막 요약을 못 받고 연결이 매달린다.
    for (const cb of [...listeners[event]]) cb(payload)
  }

  function setStatus(next) {
    status = next
    emit('state', { status, runId: id })
  }

  function warnings() {
    const out = []
    if (totals.dropped > 0) out.push('dropped')
    if (status === 'unreachable') out.push('unreachable')
    const base = baseline?.result()
    if (base?.complete) {
      if (base.failureRate !== null && base.failureRate > 0.05) out.push('baseline-unstable')
      if (base.clientFailureRate !== null && base.clientFailureRate > 0.5) out.push('client-heavy')
    }
    return out
  }

  function summary() {
    const outages = detector.outages()
    return {
      runId: id,
      status,
      startedAt,
      finishedAt,
      scenarioName: scenario.name,
      totals: { ...totals, byType: { ...totals.byType } },
      percentiles: summarizeDurations(durations),
      baseline: baseline?.result() ?? {
        complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null,
      },
      outages,
      downtimeMs: outages.reduce((sum, o) => sum + o.durationMs, 0),
      warnings: warnings(),
    }
  }

  function onRecord(record) {
    if (baseline === null) {
      // 실제로 요청이 나가기 시작한 시점이 베이스라인의 기준이다
      baseline = createBaseline({ startTs: record.ts, baselineSec: scenario.analysis.baselineSec })
    }

    totals.sent += 1
    if (record.outcome === 'success') {
      totals.success += 1
      sawSuccess = true
      networkStreak = 0
      if (typeof record.durationMs === 'number' && record.durationMs > scenario.analysis.slowThresholdMs) {
        totals.slow += 1
      }
    } else {
      totals.failure += 1
      if (record.failureType in totals.byType) totals.byType[record.failureType] += 1
      networkStreak = record.failureType === 'network' ? networkStreak + 1 : 0
    }
    if (typeof record.durationMs === 'number') durations.push(record.durationMs)

    baseline.push(record)

    const bucket = bucketer.push(record)
    if (bucket !== null) {
      buckets.push(bucket)
      emit('bucket', bucket)
    }

    const outage = detector.push(record)
    if (outage !== null) emit('outage', outage)

    // 한 번도 성공한 적 없이 network 실패만 이어진다 = 애초에 닿은 적이 없다.
    // 그대로 durationSec 을 다 돌리는 것은 시간 낭비다.
    if (!sawSuccess && networkStreak >= UNREACHABLE_STREAK && status === 'running') {
      setStatus('unreachable')
      prober.stop()
    }
  }

  return {
    id,
    scenario,
    get status() { return status },
    get startedAt() { return startedAt },
    get finishedAt() { return finishedAt },
    buckets: () => buckets,
    outages: () => detector.outages(),
    summary,

    on(event, cb) {
      listeners[event].push(cb)
      return () => {
        const i = listeners[event].indexOf(cb)
        if (i >= 0) listeners[event].splice(i, 1)
      }
    },

    async start() {
      startedAt = Date.now()
      setStatus('running')
      summaryTimer = setInterval(() => emit('summary', summary()), SUMMARY_INTERVAL_MS)

      try {
        const stats = await prober.start(scenario, onRecord)
        totals.dropped = stats.dropped
      } finally {
        clearInterval(summaryTimer)
        const lastBucket = bucketer.flush()
        if (lastBucket !== null) {
          buckets.push(lastBucket)
          emit('bucket', lastBucket)
        }
        const lastOutage = detector.finish()
        if (lastOutage !== null) emit('outage', lastOutage)

        finishedAt = Date.now()
        if (status === 'running') setStatus('finished')
        emit('summary', summary())
      }
    },

    stop() {
      if (status === 'running') setStatus('stopped')
      prober.stop()
    },
  }
}
```

`src/run/run-store.js`:

```js
/**
 * 실행 기록을 메모리에 보관한다.
 * 서버를 재시작하면 사라진다 — 노트북에서 혼자 쓰는 도구이므로 그것으로 충분하다.
 *
 * @param {{ max?: number }} options
 */
export function createRunStore({ max = 10 } = {}) {
  /** 최신이 앞에 온다 */
  let runs = []

  return {
    add(run) {
      runs.unshift(run)
      runs = runs.slice(0, max)
    },
    get(id) {
      return runs.find((r) => r.id === id)
    },
    list() {
      return runs
    },
    active() {
      return runs.find((r) => r.status === 'running')
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/run.test.js test/run-store.test.js`
Expected: PASS — 16 tests

- [ ] **Step 5: 커밋**

```bash
git add src/run test/run.test.js test/run-store.test.js
git commit -m "feat: 실행 오케스트레이션과 메모리 보관소"
```

---

### Task 12: 시나리오 검증

폼에서 온 값이 잘못돼 있으면 5분을 돌린 뒤에 알게 되는 것이 아니라 시작 전에 막는다.

**Files:**
- Create: `src/api/validate-scenario.js`
- Test: `test/validate-scenario.test.js`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `validateScenario(input) -> { ok: true, scenario } | { ok: false, errors: string[] }` — 통과하면 기본값이 채워진 정규화 시나리오를 돌려준다
  - `DEFAULTS` — 폼 기본값으로도 쓰는 상수 객체

**규칙:**

| 항목 | 규칙 |
|---|---|
| `target.url` | 필수. `http:` 또는 `https:` 스킴이어야 한다 |
| `target.method` | `GET POST PUT PATCH DELETE` 중 하나. 기본 `POST` |
| `target.headers` | 객체. 값은 문자열. 기본 `{ 'Content-Type': 'application/json' }` |
| `target.body` | 문자열. 기본 `''` |
| `target.timeoutMs` | 100 ~ 60000. 기본 5000 |
| `success.statusCodes` | 비어 있지 않은 정수 배열, 각 100~599. 기본 `[200, 201]` |
| `load.rps` | 1 ~ 200. 기본 20 |
| `load.durationSec` | 5 ~ 3600. 기본 300. 단 `baselineSec` 이 최소 5이고 `durationSec` 보다 **엄격히** 작아야 하므로 실질 하한은 6이다 — `durationSec: 5` 는 어떤 조합으로도 통과할 수 없다 |
| `analysis.slowThresholdMs` | 1 ~ 60000. 기본 1000 (타임아웃 상한과 같다. 그보다 느린 "성공"은 존재할 수 없다) |
| `analysis.baselineSec` | 5 이상이고 `durationSec` 미만. 기본 30 |
| `analysis.minConsecutiveFailures` | 1 ~ 100. 기본 3 |

`target.body` 를 아예 생략하면 빈 문자열이 된다. `DEFAULTS.target.body` 의 회원가입 템플릿이 아니다 — 그 템플릿은 폼에 처음 보여줄 값이고, 바디 없이 보낸 요청에 멋대로 채워 넣으면 곤란하다.

`rps` 상한 200은 이 도구가 부하테스트용이 아니기 때문이다. 유실 측정에 필요한 것은 꾸준한 저빈도 탐침이지 높은 처리량이 아니다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/validate-scenario.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateScenario, DEFAULTS } from '../src/api/validate-scenario.js'

const minimal = { target: { url: 'https://api.example.com/signup' } }

test('url 만 주면 나머지는 기본값으로 채워진다', () => {
  const out = validateScenario(minimal)
  assert.equal(out.ok, true)
  assert.equal(out.scenario.target.method, 'POST')
  assert.equal(out.scenario.target.timeoutMs, 5000)
  assert.deepEqual(out.scenario.success.statusCodes, [200, 201])
  assert.equal(out.scenario.load.rps, 20)
  assert.equal(out.scenario.load.durationSec, 300)
  assert.equal(out.scenario.analysis.minConsecutiveFailures, 3)
})

test('url 이 없으면 거절한다', () => {
  const out = validateScenario({ target: {} })
  assert.equal(out.ok, false)
  assert.ok(out.errors.some((e) => e.includes('주소')))
})

test('http/https 가 아닌 스킴은 거절한다', () => {
  assert.equal(validateScenario({ target: { url: 'ftp://x/y' } }).ok, false)
  assert.equal(validateScenario({ target: { url: '그냥문자열' } }).ok, false)
})

test('지원하지 않는 메서드는 거절한다', () => {
  const out = validateScenario({ target: { ...minimal.target, method: 'TRACE' } })
  assert.equal(out.ok, false)
})

test('메서드는 대소문자를 가리지 않고 대문자로 정규화한다', () => {
  assert.equal(validateScenario({ target: { ...minimal.target, method: 'post' } }).scenario.target.method, 'POST')
})

test('rps 범위를 벗어나면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, load: { rps: 0 } }).ok, false)
  assert.equal(validateScenario({ ...minimal, load: { rps: 500 } }).ok, false)
})

test('성공 상태코드가 비어 있으면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [] } }).ok, false)
})

test('성공 상태코드에 숫자가 아닌 값이 있으면 거절한다', () => {
  assert.equal(validateScenario({ ...minimal, success: { statusCodes: [200, '이백일'] } }).ok, false)
})

test('베이스라인이 실행 시간보다 길면 거절한다', () => {
  const out = validateScenario({ ...minimal, load: { durationSec: 20 }, analysis: { baselineSec: 30 } })
  assert.equal(out.ok, false)
  assert.ok(out.errors.some((e) => e.includes('베이스라인')))
})

test('헤더 값이 문자열이 아니면 거절한다', () => {
  assert.equal(validateScenario({ target: { ...minimal.target, headers: { 'X-N': 5 } } }).ok, false)
})

test('오류가 여럿이면 전부 모아서 돌려준다', () => {
  const out = validateScenario({ target: { url: 'nope' }, load: { rps: 9999 } })
  assert.equal(out.ok, false)
  assert.ok(out.errors.length >= 2)
})

test('DEFAULTS 는 그대로 검증을 통과한다', () => {
  assert.equal(validateScenario({ ...DEFAULTS, target: { ...DEFAULTS.target, url: 'https://x.dev/s' } }).ok, true)
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/validate-scenario.test.js`
Expected: FAIL — `Cannot find module '../src/api/validate-scenario.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/api/validate-scenario.js`:

```js
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
  const durationSec = num(input.load?.durationSec, DEFAULTS.load.durationSec, { min: 5, max: 3600, label: '실행 시간' }, errors)

  const slowThresholdMs = num(input.analysis?.slowThresholdMs, DEFAULTS.analysis.slowThresholdMs, { min: 1, max: 60_000, label: '지연 임계값' }, errors)
  const baselineSec = num(input.analysis?.baselineSec, DEFAULTS.analysis.baselineSec, { min: 5, max: 3600, label: '베이스라인 구간' }, errors)
  const minConsecutiveFailures = num(input.analysis?.minConsecutiveFailures, DEFAULTS.analysis.minConsecutiveFailures, { min: 1, max: 100, label: '최소 연속 실패 수' }, errors)

  if (baselineSec >= durationSec) {
    errors.push(`베이스라인 구간(${baselineSec}초)은 실행 시간(${durationSec}초)보다 짧아야 합니다.`)
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/validate-scenario.test.js`
Expected: PASS — 12 tests

- [ ] **Step 5: 커밋**

```bash
git add src/api/validate-scenario.js test/validate-scenario.test.js
git commit -m "feat: 시나리오 검증과 기본값"
```

---

### Task 13: API 라우트와 SSE 스트림

**Files:**
- Modify: `src/api/routes.js` (Task 1에서 만든 `createApp` 을 확장한다)
- Create: `src/api/sse.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: `validateScenario`/`DEFAULTS` (T12), `createRun`/`createRunStore` (T11), `createProber` (T10)
- Produces:
  - `createApp({ store, proberFactory }) -> express.Application` — 인자는 선택. 기본은 새 스토어와 `createProber('internal')`
  - `src/api/sse.js`: `openSseStream(res, { lastEventId }) -> { send(event, data, id), close() }`

**엔드포인트:**

| 메서드 | 경로 | 동작 |
|---|---|---|
| GET | `/api/health` | `{ status: 'ok' }` |
| GET | `/api/defaults` | 폼 기본값 (`DEFAULTS`) |
| POST | `/api/runs` | 검증 후 실행 시작. `201 { runId }`. 검증 실패 `400 { errors }`. 이미 실행 중이면 `409` |
| POST | `/api/runs/:id/stop` | `200 { status }`. 없으면 `404` |
| GET | `/api/runs/:id` | 요약. 없으면 `404` |
| GET | `/api/runs` | 최근 실행 목록 (최대 10건) |
| GET | `/api/runs/:id/stream` | SSE |

**SSE 규칙:**

- 연결 시 곧바로 현재 상태를 따라잡게 한다: `state` → 보관된 `bucket` 전부 → `outage` 전부 → `summary`
- `bucket` 이벤트에만 `id:` 를 붙인다. 값은 1부터 시작하는 버킷 순번
- 재연결 시 브라우저가 보내는 `Last-Event-ID` 헤더(또는 `?lastEventId=`) 이후의 버킷만 다시 보낸다
- 15초마다 주석 줄(`: ping`)을 보내 연결이 끊기지 않게 한다
- `state` 가 `running` 이 아닌 값으로 바뀌고 `summary` 를 보낸 뒤 연결을 닫는다

- [ ] **Step 1: 실패하는 테스트 작성**

`test/api.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/api/routes.js'
import { createRunStore } from '../src/run/run-store.js'

const T0 = 1_700_000_000_000
const rec = (seq, offsetMs, outcome, failureType = null) => ({
  seq, ts: T0 + offsetMs, status: outcome === 'success' ? 200 : 500,
  durationMs: outcome === 'success' ? 50 : null, outcome, failureType, error: null,
})

/** 정해둔 레코드를 흘려보내고 끝나는 가짜 프로버 */
function fakeProberFactory(records) {
  return () => ({
    async start(scenario, onRecord) {
      for (const r of records) onRecord(r)
      return { fired: records.length, dropped: 0 }
    },
    stop() {},
  })
}

async function listen(app) {
  const server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

const DEFAULT_RECORDS = [
  rec(1, 0, 'success'),
  rec(2, 1200, 'success'),
  rec(3, 2400, 'success'),
]

function appWith(records = DEFAULT_RECORDS) {
  return createApp({ store: createRunStore({ max: 10 }), proberFactory: fakeProberFactory(records) })
}

// baselineSec 을 명시한다. 기본값 30 은 durationSec 10 보다 크므로
// 교차 검사(baselineSec < durationSec)에 걸려 400 이 된다.
const body = {
  target: { url: 'https://api.example.com/signup' },
  load: { durationSec: 10 },
  analysis: { baselineSec: 5 },
}

test('GET /api/defaults 는 폼 기본값을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const out = await (await fetch(`${base}/api/defaults`)).json()
    assert.equal(out.load.rps, 20)
    assert.deepEqual(out.success.statusCodes, [200, 201])
  } finally { close() }
})

test('POST /api/runs 는 runId 를 돌려준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(res.status, 201)
    assert.match((await res.json()).runId, /^[0-9a-f-]{36}$/)
  } finally { close() }
})

test('검증에 실패하면 400 과 오류 목록을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { url: '' } }),
    })
    assert.equal(res.status, 400)
    assert.ok((await res.json()).errors.length > 0)
  } finally { close() }
})

test('GET /api/runs/:id 는 요약을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const summary = await (await fetch(`${base}/api/runs/${runId}`)).json()
    assert.equal(summary.runId, runId)
    assert.equal(summary.totals.sent, 3)
  } finally { close() }
})

test('없는 실행은 404 다', async () => {
  const { base, close } = await listen(appWith())
  try {
    assert.equal((await fetch(`${base}/api/runs/없음`)).status, 404)
  } finally { close() }
})

test('GET /api/runs 는 최근 실행 목록을 준다', async () => {
  const { base, close } = await listen(appWith())
  try {
    await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const list = await (await fetch(`${base}/api/runs`)).json()
    assert.equal(list.length, 1)
    assert.ok('status' in list[0])
  } finally { close() }
})

test('SSE 로 연결하면 지금까지의 버킷과 요약을 받는다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const res = await fetch(`${base}/api/runs/${runId}/stream`)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')

    const text = await readUntilClose(res)
    assert.ok(text.includes('event: bucket'), '버킷 이벤트가 있어야 한다')
    assert.ok(text.includes('event: summary'), '요약 이벤트가 있어야 한다')
    assert.ok(/^id: \d+$/m.test(text), '버킷에 id 가 붙어야 한다')
  } finally { close() }
})

test('Last-Event-ID 이후의 버킷만 다시 보낸다', async () => {
  const { base, close } = await listen(appWith())
  try {
    const { runId } = await (await fetch(`${base}/api/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()

    const all = await readUntilClose(await fetch(`${base}/api/runs/${runId}/stream`))
    const resumed = await readUntilClose(await fetch(`${base}/api/runs/${runId}/stream`, {
      headers: { 'Last-Event-ID': '1' },
    }))

    const count = (t) => (t.match(/event: bucket/g) ?? []).length
    assert.ok(count(resumed) < count(all), '이미 받은 버킷은 다시 보내지 않아야 한다')
  } finally { close() }
})

/** 스트림이 닫힐 때까지 전부 읽는다 */
async function readUntilClose(res) {
  let text = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  return text
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/api.test.js`
Expected: FAIL — `createApp` 이 `store`/`proberFactory` 를 받지 않아 라우트가 없다

- [ ] **Step 3: 최소 구현 작성**

`src/api/sse.js`:

```js
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
```

`src/api/routes.js` (전체 교체):

```js
import express from 'express'
import { DEFAULTS, validateScenario } from './validate-scenario.js'
import { openSseStream } from './sse.js'
import { createRun } from '../run/run.js'
import { createRunStore } from '../run/run-store.js'
import { createProber } from '../prober/index.js'

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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/api.test.js test/server.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/api test/api.test.js
git commit -m "feat: 실행 API와 SSE 스트림"
```

---

### Task 14: 내보내기 (결과 JSON, k6 스크립트)

챌린저가 이 랩에서 이미 맞춰놓은 회원가입 API 규격을, 부하테스트 챕터에서 처음부터 다시 쓰게 하지 않는다.

**Files:**
- Create: `src/export/k6-script.js`
- Modify: `src/api/routes.js` (내보내기 라우트 2개 추가)
- Test: `test/k6-script.test.js`

**Interfaces:**
- Consumes: 시나리오 형태 (T12)
- Produces:
  - `toK6Script(scenario) -> string`
  - `GET /api/runs/:id/export.json` — 요약 JSON. `Content-Disposition: attachment`
  - `GET /api/runs/:id/export.k6.js` — k6 스크립트. `Content-Disposition: attachment`

**플레이스홀더 변환:**

| 랩 | k6 |
|---|---|
| `{{uuid}}` | `${uuid()}` (스크립트에 헬퍼를 함께 심는다) |
| `{{counter}}` | `${__VU}_${__ITER}` (k6에는 전역 카운터가 없어 VU와 반복 번호를 조합한다) |
| `{{timestamp}}` | `${Date.now()}` |
| `{{random}}` | `${randomToken()}` |

바디를 템플릿 리터럴로 감싸므로 원본의 백슬래시·백틱·`${` 를 **먼저** 이스케이프한 뒤 플레이스홀더를 치환한다. 순서를 바꾸면 방금 만든 `${...}` 까지 이스케이프돼 버린다.

실행기는 `constant-arrival-rate` 를 쓴다. 이 랩의 스케줄러와 같은 개방형 모델이라 응답이 느려져도 발사 속도가 유지된다.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/k6-script.test.js`:

```js
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
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/k6-script.test.js`
Expected: FAIL — `Cannot find module '../src/export/k6-script.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/export/k6-script.js`:

```js
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

  return `// zero-downtime-lab 에서 내보낸 k6 스크립트
// 시나리오: ${scenario.name}
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
    ? `  // 회원가입은 같은 값으로 두 번 부르면 두 번째가 실패하므로 매번 고유한 값을 만든다\n  const body = \`${toTemplateLiteralBody(body)}\`\n  const res = ${call}('${url}', body, params)`
    : `  const res = ${call}('${url}', params)`}

  check(res, {
    '성공 상태코드': (r) => SUCCESS_CODES.indexOf(r.status) !== -1,
  })
}
`
}
```

`src/api/routes.js` 에 라우트 두 개를 추가한다. `app.get('/api/runs/:id', ...)` **앞에** 넣어야 한다 — 뒤에 두면 `:id` 가 `export.json` 을 먼저 잡아먹는다.

```js
// 파일 상단 import 에 추가
import { toK6Script } from '../export/k6-script.js'

// createApp 안, GET /api/runs/:id 라우트보다 먼저 배치한다
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: PASS — 전체 통과

- [ ] **Step 5: 커밋**

```bash
git add src/export src/api/routes.js test/k6-script.test.js
git commit -m "feat: 결과 JSON과 k6 스크립트 내보내기"
```

---

### Task 15: 설정 폼

브라우저에서 회원가입 API 규격을 넣는 화면. 순수 로직은 `public/lib/` 에 두어 브라우저와 Node 테스트가 같은 파일을 쓰게 한다.

> **UI 작업 전에** `emil-design-eng` 스킬을 invoke 할 것. 이 프로젝트는 자체 디자인 시스템이 없으므로 전역 지침에 따라 그 스킬이 디자인 시스템 역할을 한다.

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/lib/format.js`
- Create: `public/lib/scenario-form.js`
- Create: `public/app.js`
- Test: `test/format.test.js`
- Test: `test/scenario-form.test.js`

**Interfaces:**
- Consumes: `GET /api/defaults`, `POST /api/runs` (T13)
- Produces:
  - `public/lib/format.js`: `formatDuration(ms)`, `formatPercent(rate)`, `formatCount(n)`, `formatClock(ts)`, `formatMs(ms)`
  - `public/lib/scenario-form.js`: `headersFromText(text)`, `headersToText(headers)`, `statusCodesFromText(text)`, `buildScenario(values)`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/format.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDuration, formatPercent, formatCount, formatClock, formatMs } from '../public/lib/format.js'

test('1초 미만은 소수점 한 자리로 쓴다', () => {
  assert.equal(formatDuration(340), '0.3초')
})

test('1분 미만은 초로 쓴다', () => {
  assert.equal(formatDuration(3400), '3.4초')
  assert.equal(formatDuration(12_000), '12.0초')
})

test('1분 이상은 분과 초로 나눠 쓴다', () => {
  assert.equal(formatDuration(72_000), '1분 12초')
  assert.equal(formatDuration(120_000), '2분 0초')
})

test('0 은 0초다', () => {
  assert.equal(formatDuration(0), '0.0초')
})

test('비율은 백분율로 쓴다', () => {
  assert.equal(formatPercent(0.002), '0.2%')
  assert.equal(formatPercent(1), '100%')
  assert.equal(formatPercent(0), '0%')
})

test('비율이 null 이면 대시로 쓴다', () => {
  assert.equal(formatPercent(null), '—')
})

test('건수에 천 단위 구분을 넣는다', () => {
  assert.equal(formatCount(1234), '1,234')
  assert.equal(formatCount(0), '0')
})

test('밀리초가 null 이면 대시로 쓴다', () => {
  assert.equal(formatMs(null), '—')
  assert.equal(formatMs(1234), '1,234ms')
})

test('시각은 시:분:초로 쓴다', () => {
  // 로컬 타임존에 의존하지 않도록 형식만 확인한다
  assert.match(formatClock(1_700_000_000_000), /^\d{2}:\d{2}:\d{2}$/)
})
```

`test/scenario-form.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headersFromText, headersToText, statusCodesFromText, buildScenario } from '../public/lib/scenario-form.js'

test('헤더 텍스트를 객체로 바꾼다', () => {
  assert.deepEqual(
    headersFromText('Content-Type: application/json\nAuthorization: Bearer abc'),
    { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
  )
})

test('빈 줄과 공백을 무시한다', () => {
  assert.deepEqual(headersFromText('\n  Content-Type:  application/json  \n\n'), { 'Content-Type': 'application/json' })
})

test('값에 콜론이 있어도 첫 콜론에서만 자른다', () => {
  assert.deepEqual(headersFromText('X-Url: https://a.dev/b'), { 'X-Url': 'https://a.dev/b' })
})

test('콜론이 없는 줄은 버린다', () => {
  assert.deepEqual(headersFromText('이건헤더가아님'), {})
})

test('헤더 객체를 텍스트로 되돌린다', () => {
  assert.equal(headersToText({ A: '1', B: '2' }), 'A: 1\nB: 2')
})

test('상태코드 텍스트를 숫자 배열로 바꾼다', () => {
  assert.deepEqual(statusCodesFromText('200, 201'), [200, 201])
  assert.deepEqual(statusCodesFromText('200,201 , 409'), [200, 201, 409])
})

test('상태코드에서 숫자가 아닌 항목은 버린다', () => {
  assert.deepEqual(statusCodesFromText('200, 이백일, 201'), [200, 201])
})

test('폼 값으로 시나리오를 만든다', () => {
  const scenario = buildScenario({
    name: '회원가입',
    url: 'https://api.example.com/signup',
    method: 'POST',
    headersText: 'Content-Type: application/json',
    body: '{"email":"lab-{{uuid}}@test.local"}',
    statusCodesText: '200, 201',
    rps: '20',
    durationSec: '300',
    timeoutMs: '5000',
    slowThresholdMs: '1000',
    baselineSec: '30',
    minConsecutiveFailures: '3',
  })

  assert.equal(scenario.target.url, 'https://api.example.com/signup')
  assert.deepEqual(scenario.success.statusCodes, [200, 201])
  assert.equal(scenario.load.rps, 20)
  assert.equal(scenario.analysis.baselineSec, 30)
  assert.equal(typeof scenario.load.durationSec, 'number')
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/format.test.js test/scenario-form.test.js`
Expected: FAIL — `Cannot find module '../public/lib/format.js'`

- [ ] **Step 3: 최소 구현 작성**

`public/lib/format.js`:

```js
/** 지속 시간을 사람이 읽는 형태로 (순단 목록과 다운타임 합계에 쓴다) */
export function formatDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}분 ${seconds}초`
}

/** 0~1 비율을 백분율로. 표본이 없으면 대시 */
export function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  if (rate === 0) return '0%'
  if (rate >= 0.1) return `${(rate * 100).toFixed(0)}%`
  return `${(rate * 100).toFixed(1)}%`
}

export function formatCount(n) {
  return Number(n ?? 0).toLocaleString('ko-KR')
}

export function formatMs(ms) {
  if (ms === null || ms === undefined) return '—'
  return `${Number(ms).toLocaleString('ko-KR')}ms`
}

/** epoch ms 를 시:분:초로. 순단이 언제 시작됐는지 보여줄 때 쓴다 */
export function formatClock(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
```

`public/lib/scenario-form.js`:

```js
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
```

`public/index.html` — 구조만 잡는다. 상단이 설정, 하단이 결과.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>배포 유실 측정</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="page-head">
    <h1>배포 유실 측정</h1>
    <p class="lede">부하를 걸어둔 채 평소대로 배포하세요. 끊긴 구간이 아래에 찍힙니다.</p>
  </header>

  <main>
    <section class="panel" id="setup">
      <h2>측정 설정</h2>
      <form id="scenario-form">
        <label>대상 주소
          <input name="url" type="url" placeholder="https://api.example.com/users/signup" required>
        </label>
        <label>메서드
          <select name="method">
            <option>POST</option><option>GET</option><option>PUT</option>
            <option>PATCH</option><option>DELETE</option>
          </select>
        </label>
        <label>헤더 <span class="hint">한 줄에 하나씩, <code>이름: 값</code></span>
          <textarea name="headersText" rows="3"></textarea>
        </label>
        <label>요청 바디
          <textarea name="body" rows="4"></textarea>
          <span class="hint">
            매 요청 고유한 값이 필요합니다.
            <code>{{uuid}}</code> <code>{{counter}}</code> <code>{{timestamp}}</code> <code>{{random}}</code> 를 쓰세요.
            나중에 지우기 쉽도록 <code>lab-</code> 같은 접두어를 붙여두길 권합니다.
          </span>
        </label>
        <label>성공으로 볼 상태코드
          <input name="statusCodesText" placeholder="200, 201">
          <span class="hint">중복 가입에 409를 주는 앱이라면 409도 넣으세요.</span>
        </label>
        <div class="row">
          <label>초당 요청 수<input name="rps" type="number" min="1" max="200"></label>
          <label>실행 시간(초)<input name="durationSec" type="number" min="5" max="3600"></label>
        </div>

        <details class="advanced">
          <summary>고급 설정</summary>
          <div class="row">
            <label>타임아웃(ms)<input name="timeoutMs" type="number" min="100" max="60000"></label>
            <label>지연 임계값(ms)<input name="slowThresholdMs" type="number" min="1"></label>
          </div>
          <div class="row">
            <label>베이스라인 구간(초)<input name="baselineSec" type="number" min="5"></label>
            <label>최소 연속 실패 수<input name="minConsecutiveFailures" type="number" min="1"></label>
          </div>
          <p class="hint">
            베이스라인은 배포 전 평상시 구간입니다. 모든 수치를 이 기준과의 차이로 읽습니다.
            최소 연속 실패 수는 인터넷 구간의 단발 실패를 순단으로 오인하지 않기 위한 값입니다.
          </p>
        </details>

        <div id="form-errors" class="errors" hidden></div>
        <div class="actions">
          <button type="submit" id="start-btn">측정 시작</button>
          <button type="button" id="stop-btn" hidden>중지</button>
        </div>
      </form>
    </section>

    <section class="panel" id="result" hidden>
      <div id="warnings"></div>
      <div id="tiles" class="tiles"></div>
      <h3>순단 구간</h3>
      <ul id="outages" class="outages"><li class="empty">아직 끊긴 구간이 없습니다.</li></ul>
      <div class="actions">
        <a id="export-json" download>결과 JSON 내려받기</a>
        <a id="export-k6" download>k6 스크립트 내려받기</a>
      </div>
    </section>
  </main>

  <script type="module" src="app.js"></script>
</body>
</html>
```

`public/app.js` — 폼 부분만 먼저 (대시보드는 Task 16에서 이어 붙인다).

```js
import { buildScenario, headersToText } from './lib/scenario-form.js'

const form = document.querySelector('#scenario-form')
const errorBox = document.querySelector('#form-errors')
const startBtn = document.querySelector('#start-btn')
const stopBtn = document.querySelector('#stop-btn')

/** 서버 기본값으로 폼을 채운다. 기본값의 출처를 서버 한 곳으로 유지하기 위해서다. */
async function fillDefaults() {
  const d = await (await fetch('/api/defaults')).json()
  form.url.value = d.target.url
  form.method.value = d.target.method
  form.headersText.value = headersToText(d.target.headers)
  form.body.value = d.target.body
  form.statusCodesText.value = d.success.statusCodes.join(', ')
  form.rps.value = d.load.rps
  form.durationSec.value = d.load.durationSec
  form.timeoutMs.value = d.target.timeoutMs
  form.slowThresholdMs.value = d.analysis.slowThresholdMs
  form.baselineSec.value = d.analysis.baselineSec
  form.minConsecutiveFailures.value = d.analysis.minConsecutiveFailures
}

function showErrors(errors) {
  errorBox.hidden = errors.length === 0
  errorBox.innerHTML = errors.map((e) => `<p>${e}</p>`).join('')
}

/** 실행 중에는 설정을 못 바꾸게 잠근다 */
export function setFormDisabled(disabled) {
  for (const el of form.elements) el.disabled = disabled
  startBtn.hidden = disabled
  stopBtn.hidden = !disabled
  stopBtn.disabled = false
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  showErrors([])

  const values = Object.fromEntries(new FormData(form).entries())
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildScenario(values)),
  })

  const payload = await res.json()
  if (!res.ok) {
    showErrors(payload.errors ?? ['시작하지 못했습니다.'])
    return
  }
  setFormDisabled(true)
  window.dispatchEvent(new CustomEvent('run:started', { detail: { runId: payload.runId } }))
})

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true
  await fetch(`/api/runs/${window.currentRunId}/stop`, { method: 'POST' })
})

fillDefaults()
```

`public/styles.css` — 토큰을 먼저 정의하고 그 위에 쌓는다. 라이트/다크 모두 명시한다.

```css
/* 모션 원칙
   - 초당 갱신되는 것(타일 수치, 그래프)은 애니메이션하지 않는다. 한 번 실행에
     수백 번 반복되므로 움직임은 정보 전달을 방해하기만 한다.
   - 드물게 한 번 나타나는 것(결과 패널, 경고, 순단 항목)에만 진입 모션을 준다.
   - 버튼 누름 피드백은 항상 준다. 인터페이스가 입력을 들었다는 즉각적 신호다. */

:root {
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --bg: #fbfbfa;
  --panel: #ffffff;
  --ink: #1c1b1a;
  --ink-dim: #6b6862;
  --line: #e5e3df;
  --accent: #2f6f4e;
  --danger: #b3402f;
  --warn: #9a6a12;
  --radius: 10px;
  --gap: 16px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --panel: #1f2124;
    --ink: #eceae6;
    --ink-dim: #9b978f;
    --line: #33363b;
    --accent: #6fbf90;
    --danger: #e1705c;
    --warn: #d2a03f;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 24px 16px 64px;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', sans-serif;
}

main { max-width: 880px; margin: 0 auto; display: grid; gap: 24px; }
.page-head { max-width: 880px; margin: 0 auto 24px; }
.page-head h1 { margin: 0 0 4px; font-size: 22px; }
.lede { margin: 0; color: var(--ink-dim); }

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px;
}

form { display: grid; gap: var(--gap); }
label { display: grid; gap: 6px; font-weight: 600; font-size: 13px; }
input, select, textarea {
  font: inherit; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--ink);
}
textarea { resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.hint { font-weight: 400; color: var(--ink-dim); font-size: 12px; }
.hint code { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap); }
.actions { display: flex; gap: 8px; align-items: center; }

button, .actions a {
  font: inherit; font-weight: 600; cursor: pointer;
  padding: 9px 16px; border-radius: 6px; border: 1px solid transparent;
  background: var(--accent); color: #fff; text-decoration: none;
  transition: transform 160ms var(--ease-out), opacity 160ms ease;
}
button[type="button"], .actions a { background: transparent; color: var(--ink); border-color: var(--line); }
/* 눌렀을 때 살짝 줄어든다. 스케일은 자식까지 함께 줄여서 버튼 전체가 눌린 느낌이 된다. */
button:not(:disabled):active, .actions a:active { transform: scale(0.97); }
button:disabled { opacity: .5; cursor: default; transform: none; }

/* 한 번만 나타나는 요소의 진입. scale(0) 에서 시작하지 않는다 —
   현실에서 무에서 튀어나오는 것은 없다. */
@keyframes lab-enter {
  from { opacity: 0; transform: translateY(6px); }
}

@media (prefers-reduced-motion: reduce) {
  /* 움직임만 걷어내고 불투명도 변화는 남긴다. 이해를 돕는 쪽은 유지한다. */
  button:not(:disabled):active, .actions a:active { transform: none; }
  @keyframes lab-enter {
    from { opacity: 0; }
  }
}

.errors { border-left: 3px solid var(--danger); padding: 8px 12px; color: var(--danger); }
.errors p { margin: 2px 0; }

@media (max-width: 560px) { .row { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/format.test.js test/scenario-form.test.js`
Expected: PASS — 18 tests

브라우저 확인: `npm start` 후 `http://localhost:9376` 에서 폼이 기본값으로 채워지는지 본다.

- [ ] **Step 5: 커밋**

```bash
git add public test/format.test.js test/scenario-form.test.js
git commit -m "feat: 설정 폼과 포맷 유틸"
```

---

### Task 16: 대시보드 (요약 타일, 순단 목록, 경고)

**Files:**
- Create: `public/lib/warnings.js`
- Create: `public/lib/present.js`
- Create: `public/lib/outage-list.js`
- Modify: `public/app.js` (SSE 구독과 렌더링 추가)
- Modify: `public/styles.css` (결과 영역 스타일 추가)
- Test: `test/present.test.js`
- Test: `test/outage-list.test.js`

**Interfaces:**
- Consumes: `format.js` (T15), SSE 이벤트 (T13)
- Produces:
  - `public/lib/warnings.js`: `warningMessage(code) -> { title, body }`
  - `public/lib/outage-list.js`:

```js
/**
 * 순단 목록의 상태를 들고 있는다.
 *
 * 화면에 이미 그린 개수를 목록 자신이 함께 관리한다. 둘을 떼어 놓으면
 * 두 번째 측정을 시작할 때 목록만 비워지고 카운터는 남아, 새 순단이
 * 화면에 안 나타나는 상태가 된다.
 *
 * 중복 제거도 여기서 한다. 브라우저가 SSE 를 재연결하면 서버가 이미
 * 보낸 순단을 전부 다시 보내기 때문이다.
 */
export function createOutageList() {
  const items = []
  // startTs 로 중복을 가려낸다. 순단 검출기는 한 실행 안에서 같은 startTs 를
  // 두 번 내보내지 않으므로 안전한 키다.
  const seenStartTs = new Set()
  // 이미 그린 개수. 배열과 같은 객체 안에 있어서 실행이 바뀔 때 함께 리셋된다.
  let rendered = 0

  return {
    /**
     * 순단을 추가한다. 이미 받은 시작 시각이면 무시한다.
     * @returns {boolean} 새로 추가됐는지
     */
    add(outage) {
      if (seenStartTs.has(outage.startTs)) return false
      seenStartTs.add(outage.startTs)
      items.push(outage)
      return true
    },

    /** 아직 화면에 그리지 않은 것들을 돌려주고 그린 것으로 표시한다. */
    takeUnrendered() {
      const rest = items.slice(rendered)
      rendered = items.length
      return rest
    },

    all() {
      return items
    },

    isEmpty() {
      return items.length === 0
    },

    /**
     * 새 측정을 시작할 때 목록, 중복 검사, 렌더 위치를 함께 되돌린다.
     * 배열을 새로 만들지 않고 비운다 — all() 로 받아 간 참조를 들고 있는
     * 쪽(그래프)이 이전 실행의 내용을 계속 보지 않게 하기 위해서다.
     */
    reset() {
      items.length = 0
      seenStartTs.clear()
      rendered = 0
    },
  }
}
```

`public/lib/present.js`:
    - `summaryTiles(summary) -> Array<{ label, value, sub }>`
    - `outageLine(outage) -> string`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/outage-list.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOutageList } from '../public/lib/outage-list.js'

const outage = (startTs) => ({ startTs, endTs: startTs + 1000, durationMs: 1000, failureCount: 20, byType: {}, ongoing: false })

test('새 순단을 받아들인다', () => {
  const list = createOutageList()
  assert.equal(list.add(outage(1000)), true)
  assert.equal(list.all().length, 1)
})

test('시작 시각이 같으면 두 번 들어가지 않는다', () => {
  const list = createOutageList()
  list.add(outage(1000))
  assert.equal(list.add(outage(1000)), false)
  assert.equal(list.all().length, 1)
})

test('SSE 재연결로 전부 재전송돼도 중복이 쌓이지 않는다', () => {
  const list = createOutageList()
  const replay = [outage(1000), outage(2000)]
  replay.forEach((o) => list.add(o))
  replay.forEach((o) => list.add(o)) // 재연결
  assert.deepEqual(list.all().map((o) => o.startTs), [1000, 2000])
})

test('takeUnrendered 는 아직 안 그린 것만 준다', () => {
  const list = createOutageList()
  list.add(outage(1000))
  assert.deepEqual(list.takeUnrendered().map((o) => o.startTs), [1000])
  list.add(outage(2000))
  assert.deepEqual(list.takeUnrendered().map((o) => o.startTs), [2000])
})

test('연속으로 부르면 두 번째는 비어 있다', () => {
  const list = createOutageList()
  list.add(outage(1000))
  list.takeUnrendered()
  assert.deepEqual(list.takeUnrendered(), [])
})

test('reset 하면 목록과 렌더링 위치가 함께 돌아간다', () => {
  const list = createOutageList()
  list.add(outage(1000))
  list.add(outage(2000))
  list.takeUnrendered()

  list.reset()
  assert.equal(list.isEmpty(), true)
  // 2차 측정의 첫 순단이 바로 그려져야 한다
  list.add(outage(9000))
  assert.deepEqual(list.takeUnrendered().map((o) => o.startTs), [9000])
})

test('reset 후에는 같은 시작 시각도 다시 받아들인다', () => {
  const list = createOutageList()
  list.add(outage(1000))
  list.reset()
  assert.equal(list.add(outage(1000)), true)
})
```

`test/present.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summaryTiles, outageLine } from '../public/lib/present.js'
import { warningMessage } from '../public/lib/warnings.js'

const summary = {
  runId: 'r1', status: 'finished', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_300_000,
  totals: {
    sent: 6000, success: 5932, failure: 68,
    byType: { network: 7, timeout: 61, server: 0, client: 0 },
    slow: 12, dropped: 0,
  },
  percentiles: { p50: 84, p95: 190, p99: 420, max: 980, count: 5939 },
  baseline: { complete: true, sampleCount: 600, failureRate: 0.002, clientFailureRate: 0, p95: 150 },
  outages: [{ startTs: 1_700_000_060_000, endTs: 1_700_000_063_400, durationMs: 3400, failureCount: 68, byType: { network: 7, timeout: 61, server: 0, client: 0 }, ongoing: false }],
  downtimeMs: 3400,
  warnings: [],
}

test('타일에 총 요청과 실패 건수가 들어간다', () => {
  const tiles = summaryTiles(summary)
  const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]))
  assert.equal(byLabel['총 요청'].value, '6,000')
  assert.equal(byLabel['실패'].value, '68')
})

test('실패 타일에 유형별 내역이 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '실패')
  assert.ok(tile.sub.includes('timeout 61'))
  assert.ok(tile.sub.includes('network 7'))
})

test('실패 타일에 베이스라인 대비 델타가 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '실패율')
  assert.ok(tile.sub.includes('평소 0.2%'), `받은 값: ${tile.sub}`)
})

test('순단과 총 다운타임 타일이 있다', () => {
  const byLabel = Object.fromEntries(summaryTiles(summary).map((t) => [t.label, t]))
  assert.equal(byLabel['순단'].value, '1회')
  assert.equal(byLabel['총 다운타임'].value, '3.4초')
})

test('p95 타일에 베이스라인 p95 가 붙는다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === 'p95 지연')
  assert.equal(tile.value, '190ms')
  assert.ok(tile.sub.includes('150ms'))
})

test('지연 임계값 초과 건수 타일이 있다', () => {
  const tile = summaryTiles(summary).find((t) => t.label === '느린 응답')
  assert.equal(tile.value, '12')
})

test('순단 한 줄은 시작 시각, 지속 시간, 실패 건수를 담는다', () => {
  const line = outageLine(summary.outages[0])
  assert.match(line, /^\d{2}:\d{2}:\d{2}부터 3\.4초, 68건 실패/)
  assert.ok(line.includes('timeout 61'))
})

test('진행 중인 순단은 그렇게 표시한다', () => {
  const line = outageLine({ ...summary.outages[0], endTs: null, ongoing: true })
  assert.ok(line.includes('진행 중'))
})

test('표본이 없어도 타일이 깨지지 않는다', () => {
  const empty = {
    ...summary,
    totals: { sent: 0, success: 0, failure: 0, byType: { network: 0, timeout: 0, server: 0, client: 0 }, slow: 0, dropped: 0 },
    percentiles: { p50: null, p95: null, p99: null, max: null, count: 0 },
    baseline: { complete: false, sampleCount: 0, failureRate: null, clientFailureRate: null, p95: null },
    outages: [], downtimeMs: 0,
  }
  const tiles = summaryTiles(empty)
  assert.equal(tiles.find((t) => t.label === '총 요청').value, '0')
  assert.equal(tiles.find((t) => t.label === 'p95 지연').value, '—')
})

test('경고 코드마다 설명 문구가 있다', () => {
  for (const code of ['dropped', 'baseline-unstable', 'client-heavy', 'unreachable']) {
    const msg = warningMessage(code)
    assert.ok(msg.title.length > 0, `${code} 의 제목이 없다`)
    assert.ok(msg.body.length > 0, `${code} 의 설명이 없다`)
  }
})

test('모르는 경고 코드는 코드를 그대로 보여준다', () => {
  assert.ok(warningMessage('처음보는코드').title.includes('처음보는코드'))
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/present.test.js`
Expected: FAIL — `Cannot find module '../public/lib/present.js'`

- [ ] **Step 3: 최소 구현 작성**

`public/lib/warnings.js`:

```js
const MESSAGES = {
  dropped: {
    title: '보내지 못한 요청이 있습니다',
    body: '설정한 속도대로 요청을 쏘지 못했습니다. 이 실행의 수치는 신뢰할 수 없습니다. 초당 요청 수를 낮추거나 타임아웃을 줄여서 다시 측정해주세요.',
  },
  'baseline-unstable': {
    title: '배포 전부터 실패가 있었습니다',
    body: '평상시 구간의 실패율이 5%를 넘습니다. 배포를 시작하기 전에 이미 뭔가 잘못돼 있다는 뜻이라, 이 상태의 측정값은 배포 영향을 가려냅니다.',
  },
  'client-heavy': {
    title: '폼 설정을 확인해주세요',
    body: '평상시 구간의 실패 대부분이 4xx입니다. 요청 바디나 성공 상태코드가 대상 앱과 맞지 않을 가능성이 높습니다.',
  },
  unreachable: {
    title: '대상에 닿지 않습니다',
    body: '한 번도 성공하지 못한 채 연결이 계속 거부됐습니다. 주소와 네트워크를 확인해주세요.',
  },
}

/** 경고 코드를 사람이 읽는 문구로 */
export function warningMessage(code) {
  return MESSAGES[code] ?? { title: `알 수 없는 경고: ${code}`, body: '' }
}
```

`public/lib/present.js`:

```js
import { formatCount, formatDuration, formatMs, formatPercent, formatClock } from './format.js'

/** 0이 아닌 실패 유형만 "timeout 61, network 7" 형태로 */
function typeBreakdown(byType) {
  const parts = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
  return parts.join(', ')
}

/**
 * 요약을 타일 배열로 만든다.
 *
 * 모든 수치에 베이스라인 대비 델타를 붙이는 것이 핵심이다.
 * 노트북과 대상 사이 인터넷 노이즈는 없앨 수 없으므로,
 * 절대값이 아니라 평소와 얼마나 벌어졌는지로 읽어야 한다.
 */
export function summaryTiles(summary) {
  const { totals, percentiles, baseline, outages, downtimeMs } = summary
  const failureRate = totals.sent > 0 ? totals.failure / totals.sent : null

  return [
    { label: '총 요청', value: formatCount(totals.sent), sub: '' },
    { label: '실패', value: formatCount(totals.failure), sub: typeBreakdown(totals.byType) },
    {
      label: '실패율',
      value: formatPercent(failureRate),
      sub: baseline.failureRate !== null ? `평소 ${formatPercent(baseline.failureRate)}` : '',
    },
    { label: '순단', value: `${outages.length}회`, sub: '' },
    { label: '총 다운타임', value: formatDuration(downtimeMs), sub: '' },
    {
      label: 'p95 지연',
      value: formatMs(percentiles.p95),
      sub: baseline.p95 !== null ? `평소 ${formatMs(baseline.p95)}` : '',
    },
    { label: '느린 응답', value: formatCount(totals.slow), sub: '임계값 초과' },
  ]
}

/** 순단 하나를 한 줄로 */
export function outageLine(outage) {
  const head = `${formatClock(outage.startTs)}부터 ${formatDuration(outage.durationMs)}, ${formatCount(outage.failureCount)}건 실패`
  const detail = typeBreakdown(outage.byType)
  const tail = outage.ongoing ? ' — 진행 중' : ''
  return detail === '' ? head + tail : `${head} (${detail})${tail}`
}
```

`public/app.js` 에 이어 붙인다:

```js
import { summaryTiles, outageLine } from './lib/present.js'
import { warningMessage } from './lib/warnings.js'
import { createOutageList } from './lib/outage-list.js'

const resultPanel = document.querySelector('#result')
const tilesEl = document.querySelector('#tiles')
const outagesEl = document.querySelector('#outages')
const warningsEl = document.querySelector('#warnings')

function renderSummary(summary) {
  tilesEl.innerHTML = summaryTiles(summary).map((t) => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value">${t.value}</div>
      <div class="tile-sub">${t.sub}</div>
    </div>`).join('')

  warningsEl.innerHTML = summary.warnings.map((code) => {
    const { title, body } = warningMessage(code)
    return `<div class="warning"><strong>${title}</strong><p>${body}</p></div>`
  }).join('')
}

const outageList = createOutageList()

function renderOutages() {
  if (outageList.isEmpty()) {
    outagesEl.innerHTML = '<li class="empty">아직 끊긴 구간이 없습니다.</li>'
    return
  }
  // 첫 순단이 들어오면 "아직 없습니다" 자리를 비운다
  const placeholder = outagesEl.querySelector('.empty')
  if (placeholder !== null) outagesEl.innerHTML = ''

  for (const outage of outageList.takeUnrendered()) {
    const item = document.createElement('li')
    item.className = outage.ongoing ? 'ongoing is-new' : 'is-new'
    // textContent 로 넣는다. 대상 앱이 돌려준 값이 섞여 들어올 수 있다.
    item.textContent = outageLine(outage)
    outagesEl.append(item)
  }
}

/** 새 실행이 시작되면 이전 실행의 흔적을 지운다. */
function resetResults() {
  outageList.reset()
  tilesEl.innerHTML = ''
  warningsEl.innerHTML = ''
  renderOutages()
}

window.addEventListener('run:started', ({ detail }) => {
  window.currentRunId = detail.runId
  resultPanel.hidden = false
  document.querySelector('#export-json').href = `/api/runs/${detail.runId}/export.json`
  document.querySelector('#export-k6').href = `/api/runs/${detail.runId}/export.k6.js`
  // 같은 페이지에서 두 번째 측정을 돌리면 이전 결과가 남아 있다
  resetResults()

  const source = new EventSource(`/api/runs/${detail.runId}/stream`)

  source.addEventListener('bucket', (e) => {
    window.dispatchEvent(new CustomEvent('run:bucket', { detail: JSON.parse(e.data) }))
  })
  source.addEventListener('outage', (e) => {
    // 브라우저가 재연결하면 서버가 이미 보낸 순단을 전부 다시 보낸다.
    // 순단의 시작 시각은 한 실행 안에서 고유하므로 그것으로 중복을 거른다.
    if (!outageList.add(JSON.parse(e.data))) return
    renderOutages()
    window.dispatchEvent(new CustomEvent('run:outages', { detail: outageList.all() }))
  })
  source.addEventListener('summary', (e) => renderSummary(JSON.parse(e.data)))
  source.addEventListener('state', (e) => {
    const { status } = JSON.parse(e.data)
    if (status !== 'running') {
      setFormDisabled(false)
      source.close()
    }
  })
})
```

`public/styles.css` 에 추가:

```css
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.tile-label { font-size: 12px; color: var(--ink-dim); }
.tile-value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0; }
.tile-sub { font-size: 12px; color: var(--ink-dim); min-height: 1.2em; }

#result:not([hidden]) { animation: lab-enter 240ms var(--ease-out); }

.warning {
  border-left: 3px solid var(--warn); padding: 8px 12px; margin-bottom: 12px;
  animation: lab-enter 200ms var(--ease-out);
}
.warning strong { color: var(--warn); }
.warning p { margin: 2px 0 0; color: var(--ink-dim); font-size: 13px; }

.outages { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.outages li {
  font-variant-numeric: tabular-nums; font-size: 14px;
  border-left: 3px solid var(--danger); padding: 6px 12px;
}
.outages li.empty { border-left-color: var(--line); color: var(--ink-dim); }
.outages li.ongoing { border-left-style: dashed; }
/* 새로 추가된 항목만 애니메이션한다. 목록을 통째로 다시 그리면
   순단이 하나 늘 때마다 기존 항목이 전부 다시 튀어오른다. */
.outages li.is-new { animation: lab-enter 200ms var(--ease-out); }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/present.test.js`
Expected: PASS — 18 tests (present 11 + outage-list 7)

- [ ] **Step 5: 커밋**

```bash
git add public test/present.test.js
git commit -m "feat: 요약 타일, 순단 목록, 경고 배너"
```

---

### Task 17: 그래프

초당 성공/실패 막대와 p95 지연 라인.

**배포 구간은 빈칸이 아니라 빨간 구간으로 보인다.** 레코드의 `ts` 가 발사 시각이고 스케줄러는 대상이 죽어도 계속 발사하므로, 끊긴 초에도 버킷은 생긴다 — 그 안이 전부 실패일 뿐이다. 성공선이 0으로 떨어지고 실패선이 치솟는 모습이 실제로 보게 될 그림이다.

**그래도 빠진 초를 `null` 로 채워야 한다.** 버킷이 정말로 없는 경우가 하나 있다: in-flight 상한에 걸려 그 초의 슬롯을 전부 버렸을 때다. 드물지만 일어나면 반드시 보여야 하고(그 실행은 신뢰할 수 없다), 채우지 않으면 직선으로 이어져 버린다. `spanGaps: false` 도 같은 이유다.

**Files:**
- Create: `public/lib/chart-data.js`
- Create: `public/chart.js`
- Create: `public/vendor/uPlot.iife.min.js` (벤더링)
- Create: `public/vendor/uPlot.min.css` (벤더링)
- Modify: `public/index.html` (uPlot 링크·스크립트 태그와 `#chart` 컨테이너를 여기서 추가한다. Task 15는 아직 없는 파일을 참조하지 않는다)
- Modify: `package.json` (`uplot` devDependency와 `vendor` 스크립트)
- Modify: `public/styles.css`
- Test: `test/chart-data.test.js`

**Interfaces:**
- Consumes: Bucket (T7), Outage (T5)
- Produces:
  - `public/lib/chart-data.js`:
    - `bucketsToSeries(buckets) -> { x, success, failure, p95 }` — `x` 는 epoch 초 배열. 빠진 초는 값이 `null`
    - `outageBands(outages) -> Array<[startSec, endSec]>` — 배경 음영용. 진행 중이면 `endSec` 은 `null`
  - `public/chart.js`: `createChart(el) -> { update(buckets, outages), destroy() }`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/chart-data.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketsToSeries, outageBands } from '../public/lib/chart-data.js'

const bucket = (tsSec, success, failure, p95 = 90) => ({
  tsSec, sent: success + failure, success, failure,
  byType: { network: 0, timeout: failure, server: 0, client: 0 },
  slow: 0, p50: 50, p95, p99: 120, maxMs: 130,
})

test('빈 입력은 빈 배열이다', () => {
  assert.deepEqual(bucketsToSeries([]), { x: [], success: [], failure: [], p95: [] })
})

test('연속된 버킷은 그대로 나온다', () => {
  const out = bucketsToSeries([bucket(100, 20, 0), bucket(101, 19, 1)])
  assert.deepEqual(out.x, [100, 101])
  assert.deepEqual(out.success, [20, 19])
  assert.deepEqual(out.failure, [0, 1])
})

test('요청이 없던 초는 null 로 채운다', () => {
  // 100초와 104초 사이에 버킷이 없다 -> 끊긴 구간
  const out = bucketsToSeries([bucket(100, 20, 0), bucket(104, 20, 0)])
  assert.deepEqual(out.x, [100, 101, 102, 103, 104])
  assert.deepEqual(out.success, [20, null, null, null, 20])
  assert.deepEqual(out.failure, [0, null, null, null, 0])
  assert.deepEqual(out.p95, [90, null, null, null, 90])
})

test('p95 가 없는 버킷은 null 이다', () => {
  const out = bucketsToSeries([{ ...bucket(100, 0, 20), p95: null }])
  assert.deepEqual(out.p95, [null])
})

test('순단을 배경 음영 구간으로 바꾼다', () => {
  const bands = outageBands([
    { startTs: 100_000, endTs: 103_400, durationMs: 3400, failureCount: 68, byType: {}, ongoing: false },
  ])
  assert.deepEqual(bands, [[100, 103]])
})

test('진행 중인 순단은 끝이 null 이다', () => {
  const bands = outageBands([
    { startTs: 100_000, endTs: null, durationMs: 2000, failureCount: 40, byType: {}, ongoing: true },
  ])
  assert.deepEqual(bands, [[100, null]])
})
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `npm test -- test/chart-data.test.js`
Expected: FAIL — `Cannot find module '../public/lib/chart-data.js'`

- [ ] **Step 3: uPlot 벤더링 + 구현 작성**

먼저 차트 라이브러리를 리포지토리 안에 넣는다. 런타임에 CDN을 타지 않아야 오프라인에서도 동작한다.

```bash
npm install --save-dev uplot
mkdir -p public/vendor
cp node_modules/uplot/dist/uPlot.iife.min.js public/vendor/
cp node_modules/uplot/dist/uPlot.min.css public/vendor/
```

`package.json` 의 `scripts` 에 재현용 명령을 남긴다:

```json
"vendor": "cp node_modules/uplot/dist/uPlot.iife.min.js node_modules/uplot/dist/uPlot.min.css public/vendor/"
```

`public/index.html` 에 세 군데를 더한다.

`<head>` 의 `styles.css` 링크 **앞**에:

```html
  <link rel="stylesheet" href="vendor/uPlot.min.css">
```

`#tiles` 와 `<h3>순단 구간</h3>` **사이**에:

```html
      <div id="chart" class="chart"></div>
```

`app.js` 모듈 스크립트 **앞**에 (uPlot 이 전역으로 먼저 올라와야 한다):

```html
  <script src="vendor/uPlot.iife.min.js"></script>
```

`public/lib/chart-data.js`:

```js
/**
 * 버킷을 그래프용 계열로 바꾼다.
 *
 * 버킷은 요청이 있었던 초에만 만들어진다.
 * 빠진 초를 채우지 않고 이어 그리면 끊긴 구간이 공백이 아니라
 * 직선으로 이어져 버려서, 정작 봐야 할 것이 안 보인다.
 *
 * @param {object[]} buckets tsSec 오름차순
 */
export function bucketsToSeries(buckets) {
  if (buckets.length === 0) return { x: [], success: [], failure: [], p95: [] }

  const bySec = new Map(buckets.map((b) => [b.tsSec, b]))
  const first = buckets[0].tsSec
  const last = buckets[buckets.length - 1].tsSec

  const x = []
  const success = []
  const failure = []
  const p95 = []

  for (let sec = first; sec <= last; sec += 1) {
    const b = bySec.get(sec)
    x.push(sec)
    success.push(b ? b.success : null)
    failure.push(b ? b.failure : null)
    p95.push(b ? b.p95 : null)
  }

  return { x, success, failure, p95 }
}

/**
 * 순단을 배경 음영 구간(초 단위)으로 바꾼다.
 * 진행 중인 순단은 끝을 null 로 둔다.
 */
export function outageBands(outages) {
  return outages.map((o) => [
    Math.floor(o.startTs / 1000),
    o.endTs === null ? null : Math.floor(o.endTs / 1000),
  ])
}
```

`public/chart.js`:

```js
import { bucketsToSeries, outageBands } from './lib/chart-data.js'

/** 순단 구간을 그래프 배경에 칠하는 uPlot 플러그인 */
function outageBandPlugin(getBands) {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u
        ctx.save()
        ctx.fillStyle = 'rgba(179, 64, 47, 0.12)'
        for (const [startSec, endSec] of getBands()) {
          const x0 = u.valToPos(startSec, 'x', true)
          const x1 = u.valToPos(endSec ?? u.scales.x.max, 'x', true)
          ctx.fillRect(x0, u.bbox.top, Math.max(x1 - x0, 2), u.bbox.height)
        }
        ctx.restore()
      },
    },
  }
}

/**
 * 초당 성공/실패와 p95 지연을 그린다.
 * @param {HTMLElement} el
 */
export function createChart(el) {
  let bands = []
  let chart = null

  function build(width) {
    return new window.uPlot({
      width,
      height: 260,
      cursor: { drag: { x: true, y: false } },
      plugins: [outageBandPlugin(() => bands)],
      scales: { x: { time: true } },
      axes: [
        {},
        { label: '초당 요청' },
        { side: 1, label: 'p95 (ms)', scale: 'ms', grid: { show: false } },
      ],
      series: [
        {},
        { label: '성공', stroke: '#2f6f4e', fill: 'rgba(47,111,78,.18)', width: 2, spanGaps: false },
        { label: '실패', stroke: '#b3402f', fill: 'rgba(179,64,47,.25)', width: 2, spanGaps: false },
        { label: 'p95', stroke: '#6b6862', width: 1, dash: [4, 3], scale: 'ms', spanGaps: false },
      ],
    }, [[], [], [], []], el)
  }

  return {
    update(buckets, outages) {
      bands = outageBands(outages)
      const { x, success, failure, p95 } = bucketsToSeries(buckets)
      if (chart === null) chart = build(el.clientWidth || 840)
      chart.setData([x, success, failure, p95])
    },
    destroy() {
      chart?.destroy()
      chart = null
    },
  }
}
```

`public/app.js` 에 이어 붙인다:

```js
import { createChart } from './chart.js'

const chart = createChart(document.querySelector('#chart'))
const liveBuckets = []
let liveOutages = []

// 새 측정이 시작되면 그래프 상태도 비운다. 비우지 않으면 같은 탭에서
// 두 번째 측정을 돌릴 때 2차 버킷이 1차 위에 이어 붙어, 두 실행이
// 한 그래프에 섞여 그려진다.
window.addEventListener('run:started', () => {
  liveBuckets.length = 0
  liveOutages = []
  chart.update(liveBuckets, liveOutages)
})

window.addEventListener('run:bucket', ({ detail }) => {
  liveBuckets.push(detail)
  chart.update(liveBuckets, liveOutages)
})

window.addEventListener('run:outages', ({ detail }) => {
  liveOutages = detail
  chart.update(liveBuckets, liveOutages)
})
```

`public/styles.css` 에 추가:

```css
.chart { margin: 0 0 24px; min-height: 260px; }
.chart .u-legend { font-size: 12px; }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- test/chart-data.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: 커밋**

```bash
git add public package.json package-lock.json test/chart-data.test.js
git commit -m "feat: 초당 성공/실패와 지연 그래프"
```

---

### Task 18: 통합 테스트 — 진짜로 3초 끊고 잡히는지 확인

**이 테스트가 통과하지 못하면 도구 전체가 의미 없다.** 지금까지의 단위 테스트는 전부 합성 레코드로 돌렸다. 여기서는 진짜 HTTP 서버를 띄우고, 진짜로 죽였다가 살린다.

**Files:**
- Create: `test/integration.test.js`

**Interfaces:**
- Consumes: `createRun` (T11), `createProber` (T10)
- Produces: 없음 (검증 전용)

**확인할 것:**

1. 순단이 **정확히 1건** 잡힌다
2. 지속 시간이 실제 중단 시간(3초)과 허용오차 안에서 일치한다
3. **중단 구간에도 요청이 계속 나갔다** — coordinated omission이 없었다는 증거다. 응답을 기다리고 다음을 쏘는 구현이었다면 이 건수가 크게 모자란다
4. 복구 후 다시 성공한다

- [ ] **Step 1: 통합 테스트 작성**

`test/integration.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRun } from '../src/run/run.js'
import { createProber } from '../src/prober/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 201을 돌려주는 서버를 지정한 포트에 띄운다 */
async function startServer(port = 0) {
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.listen(port)
  await new Promise((r) => server.once('listening', r))
  return server
}

/** 소켓까지 전부 끊어 새 연결이 거부되게 만든다 (컨테이너가 죽은 상황) */
async function killServer(server) {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}

test('배포 중 3초 끊기면 순단 1건으로 잡힌다', async (t) => {
  t.diagnostic('서버를 띄우고 → 2초 뒤 죽이고 → 3초 뒤 되살린다')

  let server = await startServer()
  const port = server.address().port

  const scenario = {
    name: '통합 테스트',
    target: {
      url: `http://127.0.0.1:${port}/signup`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local"}',
      timeoutMs: 400,
    },
    success: { statusCodes: [201] },
    load: { rps: 20, durationSec: 8 },
    analysis: { slowThresholdMs: 1000, baselineSec: 5, minConsecutiveFailures: 3 },
  }

  const run = createRun({ scenario, prober: createProber('internal') })
  const started = Date.now()

  // 2초 뒤 죽이고, 그로부터 3초 뒤 같은 포트에 되살린다
  const outageScript = (async () => {
    await sleep(2000)
    await killServer(server)
    await sleep(3000)
    server = await startServer(port)
  })()

  try {
    await run.start()
  } finally {
    // 단언이 터지더라도 되살아난 서버를 반드시 닫는다.
    // 스크립트가 서버를 재시작한 뒤일 수 있으므로 먼저 끝나기를 기다린다.
    await outageScript.catch(() => {})
    await killServer(server)
  }

  const summary = run.summary()
  t.diagnostic(`총 ${summary.totals.sent}건, 실패 ${summary.totals.failure}건, 순단 ${summary.outages.length}회`)

  // 1. 순단이 정확히 1건
  assert.equal(summary.outages.length, 1, `순단이 ${summary.outages.length}회 잡혔다`)

  // 2. 지속 시간이 3초 근처. 타임아웃(400ms)과 재기동 시간을 감안해 폭을 준다
  const { durationMs } = summary.outages[0]
  assert.ok(durationMs >= 2500 && durationMs <= 4500, `순단 지속 시간이 ${durationMs}ms 로 예상 밖이다`)

  // 3. 중단 구간에도 요청이 계속 나갔어야 한다.
  //    응답을 기다린 뒤 다음을 쏘는 구현이었다면 이 건수가 크게 모자란다.
  //    20rps × 3초 = 60건이 이론값. 절반 이상은 나갔어야 한다.
  assert.ok(summary.totals.failure >= 30, `중단 구간 실패가 ${summary.totals.failure}건뿐이다 — 발사가 멈춘 것으로 보인다`)

  // 4. 복구 후 다시 성공했다
  assert.ok(summary.totals.success > 40, `성공이 ${summary.totals.success}건뿐이다`)

  // 5. 설정한 속도대로 쏘지 못한 구간이 없어야 한다
  assert.equal(summary.totals.dropped, 0, '요청을 설정대로 쏘지 못했다')

  t.diagnostic(`경과 ${Date.now() - started}ms`)
})

test('타임아웃으로 끊겨 완료 순서가 뒤집혀도 순단은 1건이다', async (t) => {
  // 이 테스트가 없으면 sequence-buffer 가 통째로 망가져도 통합 테스트는 통과한다.
  //
  // 위의 커넥션 끊기 방식은 ECONNREFUSED 로 즉시 실패해서, 완료 순서가
  // 발사 순서와 사실상 같다. 순서 복원이 필요한 상황이 아예 만들어지지 않는다.
  //
  // 여기서는 응답을 붙잡아 타임아웃을 낸다. 그러면 먼저 발사된 실패가
  // 나중에 발사된 성공보다 늦게 완료된다 — 순서를 복원하지 않으면
  // 연속 실패 구간이 성공으로 잘려 순단이 여러 건으로 쪼개진다.
  t.diagnostic('응답을 3초간 붙잡아 타임아웃을 만든다')

  let hanging = false
  /** 붙잡아 둔 응답들. 끝나면 버린다. */
  const held = []
  const server = createServer((req, res) => {
    req.resume()
    if (hanging) {
      held.push(res)
      return
    }
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  server.listen(0)
  await new Promise((r) => server.once('listening', r))

  const scenario = {
    name: '타임아웃 순단',
    target: {
      url: `http://127.0.0.1:${server.address().port}/signup`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email":"lab-{{uuid}}@test.local"}',
      timeoutMs: 400,
    },
    success: { statusCodes: [201] },
    load: { rps: 20, durationSec: 8 },
    analysis: { slowThresholdMs: 1000, baselineSec: 1, minConsecutiveFailures: 3 },
  }

  const run = createRun({ scenario, prober: createProber('internal') })
  const script = (async () => {
    await sleep(2000)
    hanging = true
    await sleep(3000)
    hanging = false
    // 클라이언트는 이미 타임아웃으로 끊었다. 남은 소켓만 정리한다.
    held.forEach((res) => res.destroy())
    held.length = 0
  })()

  try {
    await run.start()
  } finally {
    await script.catch(() => {})
    await killServer(server)
  }

  const summary = run.summary()
  t.diagnostic(`총 ${summary.totals.sent}건, 타임아웃 ${summary.totals.byType.timeout}건, 순단 ${summary.outages.length}회`)

  // 순서 복원이 깨지면 성공 레코드가 실패 구간 한가운데로 끼어들어
  // 하나였던 순단이 둘 이상으로 쪼개진다.
  assert.equal(summary.outages.length, 1, `순단이 ${summary.outages.length}회로 쪼개졌다 — 완료 순서가 발사 순서로 복원되지 않았을 수 있다`)
  assert.ok(summary.totals.byType.timeout > 30, `타임아웃이 ${summary.totals.byType.timeout}건뿐이다 — 붙잡기가 동작하지 않았다`)
  assert.equal(summary.totals.dropped, 0, '요청을 설정대로 쏘지 못했다')
})

test('멀쩡한 대상에는 순단이 잡히지 않는다', async () => {
  const server = await startServer()
  try {
    const scenario = {
      name: '대조군',
      target: {
        url: `http://127.0.0.1:${server.address().port}/signup`,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{}', timeoutMs: 1000,
      },
      success: { statusCodes: [201] },
      load: { rps: 20, durationSec: 3 },
      analysis: { slowThresholdMs: 1000, baselineSec: 1, minConsecutiveFailures: 3 },
    }

    const run = createRun({ scenario, prober: createProber('internal') })
    await run.start()

    const summary = run.summary()
    assert.equal(summary.outages.length, 0, '끊긴 적이 없는데 순단이 잡혔다')
    assert.equal(summary.downtimeMs, 0)
    assert.equal(summary.totals.failure, 0)
    assert.deepEqual(summary.warnings, [])
  } finally {
    await killServer(server)
  }
})
```

- [ ] **Step 2: 테스트 실행**

Run: `npm test -- test/integration.test.js`
Expected: PASS — 3 tests (약 25초 소요)

실패한다면 원인을 추적할 것. 특히 **3번 단언이 실패하면** 스케줄러가 응답을 기다리고 있다는 뜻이므로 Task 8을 다시 볼 것.

- [ ] **Step 3: 전체 테스트 통과 확인**

Run: `npm test`
Expected: PASS — 전체 통과

- [ ] **Step 4: 커밋**

```bash
git add test/integration.test.js
git commit -m "test: 실제 서버를 3초 끊어 순단 감지를 검증"
```

---

### Task 19: README와 도커 동작 확인

**Files:**
- Create: `README.md`
- Test: 수동 확인 (도커로 띄워서 실제로 측정해본다)

**Interfaces:**
- Consumes: 전체
- Produces: 없음

- [ ] **Step 1: README 작성**

`README.md`:

````markdown
# 배포 유실 측정 랩

배포하는 동안 요청이 실제로 유실되는지, 얼마나, 몇 초 동안 유실되는지를 확인하는 도구입니다.

## 쓰는 법

```bash
docker compose up
```

브라우저에서 `http://localhost:9376` 을 엽니다.

1. 폼에 회원가입 API 규격을 넣습니다 — 주소, 헤더, 바디, 성공으로 볼 상태코드
2. **측정 시작**을 누릅니다
3. 평소대로 배포합니다
4. 끊긴 구간이 화면에 찍힙니다 — 성공선이 0으로 떨어지고 실패가 빨갛게 차오르며, 순단 목록에 한 줄이 추가됩니다

포트가 이미 점유돼 있으면 `PORT=9999 docker compose up` 처럼 바꿀 수 있습니다.

## 화면에 나오는 것

| 항목 | 의미 |
|---|---|
| 실패 | `network`(연결 자체가 안 됨), `timeout`(응답 없음), `server`(5xx), `client`(4xx)로 나눠서 셉니다 |
| 실패율 | 평상시 대비 얼마나 벌어졌는지 함께 보여줍니다 |
| 순단 | 연속 실패가 이어진 구간. `14:32:07부터 3.4초, 68건 실패` |
| 총 다운타임 | 모든 순단의 합 |
| p95 지연 | 응답을 받은 요청만으로 계산합니다 |
| 느린 응답 | 성공했지만 임계값보다 오래 걸린 건수 |

## 요청 바디에 쓰는 치환자

회원가입은 같은 값으로 두 번 부르면 두 번째가 실패합니다. 매 요청 고유한 값을 만들어 넣으세요.

| 토큰 | 치환 결과 |
|---|---|
| `{{uuid}}` | UUID v4 |
| `{{counter}}` | 요청 일련번호 |
| `{{timestamp}}` | 발사 시각 |
| `{{random}}` | 8자리 영숫자 |

예시:

```json
{"email":"lab-{{uuid}}@test.local","password":"Test1234!","nickname":"u{{counter}}"}
```

## 알아둘 것

**테스트 데이터는 정리해주지 않습니다.** 측정하는 동안 대상 앱에 진짜 계정이 쌓입니다. 나중에 지우기 쉽도록 `lab-` 같은 접두어를 붙여두세요. 지우는 것은 앱마다 방식이 달라 이 도구가 관여하지 않습니다.

**실행 기록은 메모리에만 남습니다.** 서버를 재시작하면 사라집니다. 남겨야 할 결과는 **결과 JSON 내려받기**로 저장하세요.

**절대값이 아니라 델타로 읽으세요.** 노트북과 대상 서버 사이 인터넷 구간의 노이즈는 없앨 수 없습니다. 그래서 이 도구는 시작 후 첫 구간을 베이스라인으로 잡고 모든 수치를 그 기준과 함께 보여줍니다. `평소 0.2% → 배포 중 100%` 처럼 읽으면 노이즈가 있어도 판정이 선명합니다.

**경고 배너가 뜨면 그 실행은 믿지 마세요.** 특히 "보내지 못한 요청이 있습니다"는 설정한 속도대로 쏘지 못했다는 뜻이라 수치 전체가 왜곡됩니다.

## 부하테스트로 넘어갈 때

**k6 스크립트 내려받기**를 누르면 지금 폼에 맞춰둔 규격이 그대로 k6 스크립트로 나옵니다. 부하테스트를 할 때 그 파일부터 시작하면 API 규격을 다시 맞출 필요가 없습니다.

이 도구는 부하테스트용이 아닙니다. "배포 중 끊기는가"를 재는 데 필요한 것은 꾸준한 저빈도 탐침이지 높은 처리량이 아니라서, 초당 요청 수 상한을 200으로 두었습니다.

## 개발

```bash
npm install
npm test      # 전체 테스트
npm start     # http://localhost:9376
```

설계 문서는 `docs/superpowers/specs/2026-09-13-zero-downtime-lab-design.md` 에 있습니다.
````

- [ ] **Step 2: 도커로 실제 동작 확인**

```bash
docker compose up --build -d
sleep 5
curl -fsS http://localhost:9376/api/health
```

Expected: `{"status":"ok"}`

브라우저에서 `http://localhost:9376` 을 열고, 대상 주소에 **이 랩 자신의 헬스체크**를 넣어 한 바퀴 돌려본다:

- 대상 주소: `http://host.docker.internal:9376/api/health`
- 메서드: `GET`
- 성공 상태코드: `200`
- 실행 시간: `20`

**주의: 대상을 이 랩 자신으로 두면 안 된다.** 랩을 재시작하면 측정 엔진까지 같이 죽어서 아무것도 관측되지 않는다. 대상은 반드시 별도 프로세스여야 한다.

별도 대상 서버를 띄워 놓고 측정이 도는 동안 그 서버를 3초간 죽였다 살린다. 성공선이 0으로 떨어지고 실패가 빨갛게 차오르며, 순단 목록에 한 줄이 찍혀야 한다. 이것이 이 도구가 제대로 동작한다는 최종 확인이다.

```bash
docker compose down
```

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs: 사용법과 주의사항"
```

---

## 완료 기준

- [ ] `npm test` 전체 통과
- [ ] `docker compose up` 후 `localhost:9376` 에서 폼이 뜨고 측정이 돈다
- [ ] 측정 중 **별도 프로세스인** 대상을 재시작하면 순단이 잡히고, 성공선이 0으로 떨어지며 실패가 빨갛게 차오른다
- [ ] 결과 JSON과 k6 스크립트를 내려받을 수 있다
- [ ] 스펙의 비범위 항목(배포 트리거, 데이터 정리, Prometheus/Grafana, 램프업 부하테스트)이 구현돼 있지 않다
