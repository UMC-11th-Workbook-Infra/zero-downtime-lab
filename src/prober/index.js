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
