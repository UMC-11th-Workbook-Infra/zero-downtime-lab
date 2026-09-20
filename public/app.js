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
