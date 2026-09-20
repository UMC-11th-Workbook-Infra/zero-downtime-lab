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
