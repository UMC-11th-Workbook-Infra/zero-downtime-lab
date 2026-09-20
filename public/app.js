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

import { summaryTiles, outageLine } from './lib/present.js'
import { warningMessage } from './lib/warnings.js'

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

/** 이미 그린 순단 개수. 새로 들어온 것만 덧붙이기 위해 기억한다. */
let renderedOutages = 0

function renderOutages(outages) {
  if (outages.length === 0) {
    outagesEl.innerHTML = '<li class="empty">아직 끊긴 구간이 없습니다.</li>'
    renderedOutages = 0
    return
  }
  // 첫 순단이 들어오면 "아직 없습니다" 자리를 비운다
  if (renderedOutages === 0) outagesEl.innerHTML = ''

  for (let i = renderedOutages; i < outages.length; i += 1) {
    const item = document.createElement('li')
    item.className = outages[i].ongoing ? 'ongoing is-new' : 'is-new'
    // textContent 로 넣는다. 대상 앱이 돌려준 값이 섞여 들어올 수 있다.
    item.textContent = outageLine(outages[i])
    outagesEl.append(item)
  }
  renderedOutages = outages.length
}

window.addEventListener('run:started', ({ detail }) => {
  window.currentRunId = detail.runId
  resultPanel.hidden = false
  document.querySelector('#export-json').href = `/api/runs/${detail.runId}/export.json`
  document.querySelector('#export-k6').href = `/api/runs/${detail.runId}/export.k6.js`

  const outages = []
  const source = new EventSource(`/api/runs/${detail.runId}/stream`)

  source.addEventListener('bucket', (e) => {
    window.dispatchEvent(new CustomEvent('run:bucket', { detail: JSON.parse(e.data) }))
  })
  source.addEventListener('outage', (e) => {
    outages.push(JSON.parse(e.data))
    renderOutages(outages)
    window.dispatchEvent(new CustomEvent('run:outages', { detail: outages }))
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
