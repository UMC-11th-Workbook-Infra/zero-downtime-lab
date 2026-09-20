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
