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
