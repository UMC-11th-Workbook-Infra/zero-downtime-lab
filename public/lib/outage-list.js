/**
 * 순단 목록과 "얼마나 그렸는지"를 한 객체 안에 둔다.
 *
 * 이 둘을 따로 들고 있으면 두 가지 방식으로 어긋날 수 있다.
 *   1. 새 실행이 시작될 때 배열은 새로 만들면서 렌더 위치 카운터를 리셋하는 걸
 *      잊으면, 이전 실행의 화면이 새 실행에서도 그대로 남는다.
 *   2. SSE 재연결 시 서버가 기존 순단을 다시 보내는데 중복 검사가 없으면
 *      같은 순단이 화면에 두 번 찍힌다.
 * 상태를 한 곳에 모아 두면 이 두 실수가 구조적으로 불가능해진다.
 */
export function createOutageList() {
  const items = []
  // startTs 로 중복을 가려낸다. 순단 검출기는 실행 하나 안에서
  // 같은 startTs 를 두 번 내보내지 않으므로 안전한 키다.
  const seenStartTs = new Set()
  // 이미 그린 개수. 배열과 같은 객체 안에 있어서 실행이 바뀔 때 함께 리셋된다.
  let rendered = 0

  return {
    /** 순단을 추가한다. 이미 받은 시작 시각이면 무시하고 false 를 돌려준다. */
    add(outage) {
      if (seenStartTs.has(outage.startTs)) return false
      seenStartTs.add(outage.startTs)
      items.push(outage)
      return true
    },
    /** 아직 화면에 그리지 않은 순단만 꺼내고, 그린 것으로 표시한다. */
    takeUnrendered() {
      const unrendered = items.slice(rendered)
      rendered = items.length
      return unrendered
    },
    /** 지금까지 쌓인 순단 전체 */
    all() {
      return items
    },
    isEmpty() {
      return items.length === 0
    },
    /**
     * 새 실행을 시작할 때 호출한다. 목록, 중복 검사, 렌더 위치를 함께 비운다.
     *
     * 배열을 새로 만들지 않고 제자리에서 비운다 — all() 이 내부 배열의
     * 참조를 그대로 내주기 때문에, 여기서 새 배열로 바꿔치기하면 그
     * 참조를 이미 들고 있는 쪽(예: 차트)은 리셋을 못 보고 이전 실행의
     * 순단을 계속 들고 있게 된다.
     */
    reset() {
      items.length = 0
      seenStartTs.clear()
      rendered = 0
    },
  }
}
