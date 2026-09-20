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
import { createOutageList } from './lib/outage-list.js'

const resultPanel = document.querySelector('#result')
const tilesEl = document.querySelector('#tiles')
const outagesEl = document.querySelector('#outages')
const warningsEl = document.querySelector('#warnings')

// 실행 하나를 넘어 살아있다. 실행이 새로 시작될 때는 reset() 으로 비운다 —
// 목록과 렌더 위치, 중복 검사가 한 객체 안에 있어서 리셋을 깜빡할 수 없다.
const outageList = createOutageList()

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

function renderOutages() {
  if (outageList.isEmpty()) {
    outagesEl.innerHTML = '<li class="empty">아직 끊긴 구간이 없습니다.</li>'
    return
  }
  // 첫 순단이 들어오면 "아직 없습니다" 자리를 비운다
  if (outagesEl.querySelector('.empty')) outagesEl.innerHTML = ''

  for (const outage of outageList.takeUnrendered()) {
    const item = document.createElement('li')
    item.className = outage.ongoing ? 'ongoing is-new' : 'is-new'
    // textContent 로 넣는다. 대상 앱이 돌려준 값이 섞여 들어올 수 있다.
    item.textContent = outageLine(outage)
    outagesEl.append(item)
  }
}

/** 새 실행을 시작할 때 이전 실행의 결과가 화면에 남지 않도록 지운다 */
function resetResults() {
  tilesEl.innerHTML = ''
  warningsEl.innerHTML = ''
  outageList.reset()
  renderOutages()
}

window.addEventListener('run:started', ({ detail }) => {
  window.currentRunId = detail.runId
  resultPanel.hidden = false
  document.querySelector('#export-json').href = `/api/runs/${detail.runId}/export.json`
  document.querySelector('#export-k6').href = `/api/runs/${detail.runId}/export.k6.js`

  resetResults()
  const source = new EventSource(`/api/runs/${detail.runId}/stream`)

  source.addEventListener('bucket', (e) => {
    window.dispatchEvent(new CustomEvent('run:bucket', { detail: JSON.parse(e.data) }))
  })
  source.addEventListener('outage', (e) => {
    // SSE 재연결 시 서버가 기존 순단을 다시 보낼 수 있다. 중복이면 무시한다.
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

/**
 * 새로고침 등으로 페이지가 다시 열렸을 때 실행 중이던 측정을 이어 붙인다.
 *
 * F5 전에는 서버가 계속 돌고 있는데 브라우저 쪽 상태(window.currentRunId,
 * 폼 잠금, Stop 버튼)만 사라진다. 그대로 다시 시작하려 하면 409 "먼저
 * 중지해주세요"를 받는데, 중지 버튼이 없으니 따를 수 없는 조언이다.
 *
 * GET /api/runs 로 실행 중인 것이 있는지 확인하고, 있으면 그 실행에 대해
 * run:started 를 다시 발생시킨다 — SSE 재구독, 결과 패널, 내보내기
 * 링크, Stop 버튼이 전부 처음 시작할 때와 같은 경로로 복원된다. 놓친
 * 버킷/순단은 SSE 쪽의 캐치업 재생이 채워준다.
 */
async function restoreRunningRun() {
  const runs = await (await fetch('/api/runs')).json()
  const running = runs.find((r) => r.status === 'running')
  if (running === undefined) return

  setFormDisabled(true)
  window.dispatchEvent(new CustomEvent('run:started', { detail: { runId: running.runId } }))
}

restoreRunningRun()
