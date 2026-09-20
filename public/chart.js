import { bucketsToSeries, outageBands } from './lib/chart-data.js'

/** 순단 구간을 그래프 배경에 칠하는 uPlot 플러그인 */
function outageBandPlugin(getBands) {
  return {
    hooks: {
      draw: (u) => {
        const { ctx } = u
        ctx.save()
        ctx.fillStyle = 'rgba(179, 64, 47, 0.12)'
        for (const [startSec, endSec] of getBands()) {
          const x0 = u.valToPos(startSec, 'x', true)
          const x1 = u.valToPos(endSec ?? u.scales.x.max, 'x', true)
          ctx.fillRect(x0, u.bbox.top, Math.max(x1 - x0, 2), u.bbox.height)
        }
        ctx.restore()
      },
    },
  }
}

/**
 * 초당 성공/실패와 p95 지연을 그린다.
 * @param {HTMLElement} el
 */
export function createChart(el) {
  let bands = []
  let chart = null

  function build(width) {
    return new window.uPlot({
      width,
      height: 260,
      cursor: { drag: { x: true, y: false } },
      plugins: [outageBandPlugin(() => bands)],
      scales: { x: { time: true } },
      axes: [
        {},
        { label: '초당 요청' },
        { side: 1, label: 'p95 (ms)', scale: 'ms', grid: { show: false } },
      ],
      series: [
        {},
        { label: '성공', stroke: '#2f6f4e', fill: 'rgba(47,111,78,.18)', width: 2, spanGaps: false },
        { label: '실패', stroke: '#b3402f', fill: 'rgba(179,64,47,.25)', width: 2, spanGaps: false },
        { label: 'p95', stroke: '#6b6862', width: 1, dash: [4, 3], scale: 'ms', spanGaps: false },
      ],
    }, [[], [], [], []], el)
  }

  return {
    update(buckets, outages) {
      bands = outageBands(outages)
      const { x, success, failure, p95 } = bucketsToSeries(buckets)
      if (chart === null) chart = build(el.clientWidth || 840)
      chart.setData([x, success, failure, p95])
    },
    destroy() {
      chart?.destroy()
      chart = null
    },
  }
}
