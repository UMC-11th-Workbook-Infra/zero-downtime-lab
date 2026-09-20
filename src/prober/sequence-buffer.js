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
