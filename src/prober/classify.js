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
