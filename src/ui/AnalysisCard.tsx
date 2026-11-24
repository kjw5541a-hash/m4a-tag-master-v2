// 분석 카드: 분석 상태, BPM·조성 수정, 반복 코드 진행 (기획서 6.2, 5.5).
import { keyLabel, PITCH_CLASSES, spellChord, type MappAnalysisV1 } from '../schema.ts'
import { SAVED_BEFORE, useQueue, type Item } from '../store.ts'

const button = 'min-h-11 min-w-11 rounded-lg border border-gray-300 px-3 text-sm disabled:opacity-50'
// 값은 파일과 같은 # 표기, 보이는 글자는 조성에 맞춘 표기(F10)
const KEYS = PITCH_CLASSES.flatMap((k) => (['major', 'minor'] as const).map((scale) => ({ value: `${k} ${scale}`, label: keyLabel(k, scale) })))

export default function AnalysisCard({ id, job, analysis }: { id: string; job?: Item['analysisJob']; analysis?: MappAnalysisV1 }) {
  if (!job) return null
  const { analyze, editAnalysis } = useQueue.getState()
  const rerun = () => {
    if (analysis?.edited && !confirm('수정한 값이 덮어써져요. 다시 분석할까요?')) return
    void analyze(id)
  }
  const retry = (
    <button className={button} onClick={rerun}>
      다시 분석
    </button>
  )

  // BPM 입력은 제목 줄에 붙여 한 줄을 아낀다(편집 화면이 한 화면에 들어오게).
  let controls
  let body
  if (job.state === 'waiting') body = <p>분석 대기</p>
  else if (job.state === 'running') body = <p>{`분석 중 ${Math.round((job.progress ?? 0) * 100)}%`}</p>
  else if (job.state === 'done' && analysis) {
    // 값이 바뀌면 사용자가 고친 것으로 쓴다. 분석이 도는 동안에는 이 컨트롤을 그리지 않아, 늦게 온 결과가 사용자 수정을 덮지 못한다.
    // BPM이 바뀌면 코드도 그 BPM의 반 마디로 다시 묶인다(스토어 editAnalysis).
    const change = (patch: Parameters<typeof editAnalysis>[1]) => editAnalysis(id, patch)
    // 입력 중에는 값을 쓰지 않고, 입력란을 벗어날 때 한 번만 반영한다. 잘못된 값이면 되돌린다.
    const commitBpm = (el: HTMLInputElement) => {
      const v = Math.round(el.valueAsNumber * 10) / 10
      if (v > 0 && v < 1000 && v !== analysis.bpm) change({ bpm: v })
      else el.value = String(analysis.bpm)
    }
    controls = (
      <>
        <span className="text-gray-500">BPM</span>
        <input
          key={analysis.bpm}
          type="number"
          inputMode="decimal"
          step="0.1"
          aria-label="BPM 직접 입력"
          className="min-h-11 w-20 rounded-lg border border-gray-300 px-3 text-base"
          defaultValue={analysis.bpm}
          onBlur={(ev) => commitBpm(ev.currentTarget)}
        />
        <button className={button} onClick={() => change({ bpm: analysis.bpm * 2 })}>
          ×2
        </button>
        <button className={button} onClick={() => change({ bpm: analysis.bpm / 2 })}>
          ÷2
        </button>
      </>
    )
    body = (
      <>
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="w-10 shrink-0 text-gray-500">조성</span>
            <select
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-base"
              value={`${analysis.key} ${analysis.scale}`}
              onChange={(ev) => {
                const [key, scale] = ev.target.value.split(' ') as [MappAnalysisV1['key'], MappAnalysisV1['scale']]
                change({ key, scale })
              }}
            >
              {KEYS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          {retry}
        </div>
        <div className="flex gap-2 text-sm">
          <p className="shrink-0 text-gray-500">주요 진행</p>
          {analysis.topProgressions.length ? (
            <ul className="min-w-0">
              {analysis.topProgressions.map((p) => (
                <li key={p.chords.join('-')}>{`${p.chords.map((c) => spellChord(c, analysis.key, analysis.scale)).join('–')} (${p.count}회)`}</li>
              ))}
            </ul>
          ) : (
            <p>반복 진행 없음</p>
          )}
        </div>
      </>
    )
  } else
    body = (
      <div className="flex items-center gap-2">
        <p className="flex-1">{job.message}</p>
        {(job.state === 'failed' || job.message === SAVED_BEFORE) && retry}
      </div>
    )

  return (
    <section className="space-y-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">분석 (참고용)</h2>
        {controls}
      </div>
      {body}
    </section>
  )
}
