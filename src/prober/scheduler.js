/**
 * 고정 레이트로 발사 신호를 낸다.
 *
 * 응답을 기다린 뒤 다음을 쏘면, 대상이 죽어 응답이 없는 구간에서
 * 요청 속도도 같이 죽는다. 유실을 재는 도구가 유실 구간에서 눈을 감는 셈이다.
 * 그래서 in-flight 여부와 무관하게 절대 시각 기준으로 슬롯을 잡는다.
 *
 * @param {{ intervalMs: number, maxInFlight: number }} options
 */
export function createScheduler({ intervalMs, maxInFlight }) {
  let running = false
  let timer = null
  let startedAt = 0
  let slot = 0
  let seq = 0
  let fired = 0
  let dropped = 0
  let inFlight = 0

  function fire(onFire) {
    seq += 1
    fired += 1
    inFlight += 1
    // onFire 가 동기적으로 던지는 경우까지 감싼다
    Promise.resolve()
      .then(() => onFire(seq))
      .catch(() => {})
      .finally(() => { inFlight -= 1 })
  }

  function loop(onFire) {
    if (!running) return

    let target = startedAt + slot * intervalMs
    const now = Date.now()

    if (now - target > intervalMs) {
      // 이벤트 루프가 밀렸다. 놓친 슬롯을 몰아서 쏘면 그 순간의 측정이 왜곡되므로,
      // 발사하지 않고 버린 것으로 센다.
      const missed = Math.floor((now - target) / intervalMs)
      dropped += missed
      slot += missed
      target = startedAt + slot * intervalMs
    }

    timer = setTimeout(() => {
      if (!running) return
      if (inFlight >= maxInFlight) {
        dropped += 1
      } else {
        fire(onFire)
      }
      slot += 1
      loop(onFire)
    }, Math.max(0, target - Date.now()))
  }

  return {
    /** @param {(seq: number) => Promise<void>} onFire */
    start(onFire) {
      if (running) return
      running = true
      startedAt = Date.now()
      slot = 0
      loop(onFire)
    },

    stop() {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },

    stats() {
      return { fired, dropped, inFlight }
    },
  }
}
