// 곡 큐: 파일 읽기 → 자동 조회 → 확인 필요 (기획서 3장 S1, 5.1, 9장). 화면은 이 스토어만 읽고 움직인다.
import { create } from 'zustand'
import { checkSize, inspect, readTags, Mp4Error } from './mp4.ts'
import { parseSource, type ParsedSource } from './lookup/query.ts'
import { searchItunes, type Candidate } from './lookup/itunes.ts'
import { fetchBytes, LookupError } from './lookup/http.ts'
import { findLyrics } from './lookup/lyrics.ts'
import { AnalysisError, MAX_ANALYSIS_SEC, runAnalysis, TOO_LONG } from './runAnalysis.ts'
import { applyLyrics, initialEdit, selectCandidate, type Edit, type Source } from './edit.ts'
import { regroup, type BeatChroma } from './analysis.ts'
import { editAnalysis, type MappAnalysisV1 } from './schema.ts'

export type Status = 'reading' | 'searching' | 'review' | 'saved' | 'failed'

export const STATUS_LABEL: Record<Status, string> = {
  reading: '읽는 중',
  searching: '검색 중',
  review: '저장 필요',
  saved: '저장됨',
  failed: '실패',
}

export type AnalysisState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

const REVIEW_LABEL: Record<AnalysisState, string> = {
  waiting: '분석 대기',
  running: '분석 중',
  done: '분석 완료, 저장 필요',
  failed: '분석 실패, 저장 필요',
  skipped: '분석 건너뜀, 저장 필요',
}

/** 큐 카드와 편집 화면에 보이는 상태. 조회가 끝난 곡은 분석 상태를 함께 보여 준다. */
export function statusLabel(item: Pick<Item, 'status' | 'analysisJob'>): string {
  const job = item.analysisJob
  if (item.status !== 'review' || !job) return STATUS_LABEL[item.status]
  return job.state === 'running' ? `분석 중 ${Math.round((job.progress ?? 0) * 100)}%` : REVIEW_LABEL[job.state]
}

/** 큐의 [모두 저장] 대상(저장 필요 곡, 큐 순서)과, 검색·분석이 남아 아직 누르면 안 되는지. */
export function saveAllTargets(items: Item[]): { ready: Item[]; busy: boolean } {
  const busy = items.some(
    (i) =>
      i.status === 'reading' ||
      i.status === 'searching' ||
      i.analysisJob?.state === 'waiting' ||
      i.analysisJob?.state === 'running',
  )
  return { ready: items.filter((i) => i.status === 'review'), busy }
}

export interface Item {
  id: string
  fileName: string
  status: Status
  error?: string
  source?: Source
  // lookup의 기본 검색어와 화면의 [원본] 값에 쓴다.
  parsed?: ParsedSource
  edit?: Edit
  savedAs?: string
  // [모두 저장]에서 검증에 걸린 이유. 검색 오류(error)와 따로 둔다: error는 편집 화면의 [다시 시도](재검색)와 묶여 있다.
  saveError?: string
  analysisJob?: { state: AnalysisState; progress?: number; message?: string }
  // 이번 분석의 비트 사이 크로마(메모리 전용). BPM을 고치면 이것으로 코드를 다시 묶는다. 파일에서 읽은 분석에는 없다.
  chroma?: BeatChroma
}

interface Queue {
  items: Item[]
  addFiles(files: File[]): { ids: string[]; done: Promise<void> }
  lookup(id: string, query?: string): Promise<void>
  choose(id: string, c: Candidate): Promise<void>
  analyze(id: string): Promise<void>
  update(id: string, patch: Partial<Edit>): void
  editAnalysis(id: string, patch: Partial<Pick<MappAnalysisV1, 'bpm' | 'key' | 'scale'>>): void
  remove(id: string): void
  markSaved(id: string, savedAs: string): void
  setSaveError(id: string, message: string): void
}

const lookupMessage = (e: unknown) => (e instanceof LookupError ? e.message : '검색 중 오류가 났어요')

// 커버를 못 받아도 조회는 이어 간다.
const downloadCover = (c: Candidate) => (c.artworkUrl ? fetchBytes(c.artworkUrl).catch(() => undefined) : undefined)

// 항목별 요청 번호. 조회·선택을 시작할 때마다 올린다. 기다린 뒤 번호가 바뀌었으면 더 새 요청이 있으니 결과를 버린다.
// update·remove·markSaved는 올리지 않는다.
const latest = new Map<string, number>()
function begin(id: string): () => boolean {
  const n = (latest.get(id) ?? 0) + 1
  latest.set(id, n)
  return () => latest.get(id) === n
}

// 파일에 분석이 이미 있으면 그대로 쓰고, 15분을 넘으면 건너뛴다.
export function initialJob(edit: Edit, durationSec: number): { state: AnalysisState; message?: string } {
  if (edit.analysis) return { state: 'done' }
  return durationSec > MAX_ANALYSIS_SEC ? { state: 'skipped', message: TOO_LONG } : { state: 'waiting' }
}

let runner: typeof runAnalysis = runAnalysis
/** 테스트용: 분석 실행기를 바꾼다. */
export const setAnalysisRunner = (fn: typeof runAnalysis) => {
  runner = fn
}

// 분석은 한 번에 한 곡: 메모리 때문에 곡마다 앞 분석이 끝나기를 기다린다. 사슬의 각 고리는 reject하지 않는다.
let analysisTail: Promise<void> = Promise.resolve()
// 항목별 분석 요청 번호. lookup의 begin과는 따로 센다(검색을 다시 해도 분석을 버리지 않는다).
const analysisLatest = new Map<string, number>()

export const useQueue = create<Queue>()((set, get) => {
  const item = (id: string) => get().items.find((i) => i.id === id)
  const patch = (id: string, p: Partial<Item>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }))
  // 기다리는 사이 사용자가 고친 값을 덮어쓰지 않도록, 조회 결과는 그 시점의 edit에 적용한다.
  const patchEdit = (id: string, fn: (e: Edit) => Edit) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id && i.edit ? { ...i, edit: fn(i.edit) } : i)) }))

  const lyricsFor = async (id: string, current: () => boolean) => {
    const { source, edit } = item(id) ?? {}
    if (!source || !edit) return
    const r = await findLyrics({ title: edit.title, artist: edit.artist, itunes: edit.candidate, fileDurationSec: source.duration })
    if (current()) patchEdit(id, (e) => applyLyrics(e, r))
  }

  // 분석은 검색과 동시에 시작하고 기다리지 않는다. 시작한 분석은 analyses에 넣어 호출한 쪽이 기다리게 한다.
  const load = async (id: string, file: File, analyses: Promise<void>[]) => {
    let waiting = false
    try {
      checkSize(file.size)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { duration } = inspect(bytes)
      const source: Source = { fileName: file.name, bytes, duration, tags: readTags(bytes) }
      const parsed = parseSource(file.name, source.tags)
      const edit = initialEdit(source, parsed)
      const analysisJob = initialJob(edit, duration)
      patch(id, { source, parsed, edit, analysisJob, status: 'searching' })
      waiting = analysisJob.state === 'waiting'
    } catch (e) {
      patch(id, { status: 'failed', error: e instanceof Mp4Error ? e.message : '파일을 읽지 못했어요' })
      return
    }
    if (waiting) analyses.push(get().analyze(id))
    await get().lookup(id)
  }

  return {
    items: [],

    addFiles(files) {
      const ids = files.map(() => crypto.randomUUID())
      set((s) => ({
        items: [...s.items, ...files.map((f, i): Item => ({ id: ids[i]!, fileName: f.name, status: 'reading' }))],
      }))
      const done = (async () => {
        // 한 곡씩 차례로: iTunes 호출 제한과 메모리 때문에 병렬로 하지 않는다.
        const analyses: Promise<void>[] = []
        for (const [i, file] of files.entries()) await load(ids[i]!, file, analyses)
        await Promise.all(analyses)
      })()
      return { ids, done }
    },

    async lookup(id, query) {
      const { source, parsed } = item(id) ?? {}
      if (!source || !parsed) return
      const current = begin(id)
      patch(id, { status: 'searching', error: undefined })
      let error: string | undefined
      try {
        const found = await searchItunes(query ? [query] : parsed.queries)
        if (!current()) return
        const first = found.candidates[0]
        const artwork = first && (await downloadCover(first))
        if (!current()) return
        patchEdit(id, (e) => {
          const next = { ...e, query: found.query, candidates: found.candidates }
          return first ? selectCandidate(next, source, first, artwork) : next
        })
        await lyricsFor(id, current)
      } catch (e) {
        error = lookupMessage(e)
      }
      // 조회 중에 저장됐으면 상태를 되돌리지 않는다.
      if (current() && item(id)?.status === 'searching') patch(id, { status: 'review', error })
    },

    async choose(id, c) {
      const source = item(id)?.source
      if (!source) return
      const current = begin(id)
      // 아트워크·가사를 받는 동안 화면이 잠기도록 '검색 중'으로 둔다. 안 그러면 그 사이 저장이 옛 후보의 값을 쓰고 '저장됨'이 된다.
      patch(id, { status: 'searching', error: undefined })
      const artwork = await downloadCover(c)
      if (!current()) return
      patchEdit(id, (e) => selectCandidate(e, source, c, artwork))
      try {
        if (!item(id)?.edit?.lyricsManual) await lyricsFor(id, current)
      } catch (e) {
        if (current()) patch(id, { error: lookupMessage(e) })
      }
      // 위에서 켠 '검색 중'을 끝낸다. 조회 중에 고른 경우 그 조회는 버려졌으니 여기서 끝내는 것이기도 하다.
      if (current() && item(id)?.status === 'searching') patch(id, { status: 'review' })
    },

    analyze(id) {
      const source = item(id)?.source
      if (!source) return Promise.resolve()
      const n = (analysisLatest.get(id) ?? 0) + 1
      analysisLatest.set(id, n)
      const current = () => analysisLatest.get(id) === n
      // 컨테이너 길이로 먼저 거른다. 디코드는 메모리를 많이 쓰므로 15분 넘는 곡은 디코드하지 않는다.
      if (source.duration > MAX_ANALYSIS_SEC) {
        patch(id, { analysisJob: { state: 'skipped', message: TOO_LONG } })
        return Promise.resolve()
      }
      patch(id, { analysisJob: { state: 'waiting' } })
      const run = analysisTail.then(async () => {
        // 기다리는 사이 더 새 요청이 생겼거나 곡이 지워졌으면 돌지 않는다.
        if (!current() || !item(id)) return
        patch(id, { analysisJob: { state: 'running', progress: 0 } })
        try {
          const { analysis, chroma } = await runner(source.bytes, (progress) => {
            if (current()) patch(id, { analysisJob: { state: 'running', progress } })
          })
          if (!current()) return
          // 분석이 파일에 들어갈 값이므로, 저장된 곡은 화면과 파일이 달라진 것이니 다시 확인하게 한다.
          set((s) => ({
            items: s.items.map((i) =>
              i.id === id && i.edit
                ? { ...i, edit: { ...i.edit, analysis }, chroma, analysisJob: { state: 'done' }, status: i.status === 'saved' ? 'review' : i.status }
                : i,
            ),
          }))
        } catch (e) {
          if (current()) {
            const message = e instanceof AnalysisError ? e.message : '분석 중 메모리가 부족했어요'
            // 디코드 뒤에 15분 초과를 알게 된 경우는 실패가 아니라 건너뜀이다.
            patch(id, { analysisJob: { state: message === TOO_LONG ? 'skipped' : 'failed', message } })
          }
        }
      })
      analysisTail = run
      return run
    },

    update: (id, p) =>
      set((s) => ({
        items: s.items.map((i) => {
          if (i.id !== id || !i.edit) return i
          // 저장한 뒤 검색어 말고 다른 값을 고치면 파일이 화면과 달라진 것이니 다시 확인하게 한다. savedAs는 남긴다.
          const dirty = i.status === 'saved' && Object.keys(p).some((k) => k !== 'query')
          return { ...i, edit: { ...i.edit, ...p }, status: dirty ? 'review' : i.status }
        }),
      })),
    // 사람이 BPM·조성을 고친다. BPM이 바뀌고 이번 분석의 크로마가 있으면 그 BPM의 반 마디로 코드를 다시 묶는다.
    editAnalysis(id, p) {
      const it = item(id)
      const a = it?.edit?.analysis
      if (!a) return
      let next = editAnalysis(a, p)
      if (next === a) return // 범위 밖 bpm 등은 아무것도 바꾸지 않아, 저장된 곡을 '저장 필요'로 돌리지 않는다
      if (next.bpm !== a.bpm && it.chroma) next = regroup(next, it.chroma)
      get().update(id, { analysis: next })
    },
    remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    markSaved: (id, savedAs) => patch(id, { status: 'saved', savedAs, saveError: undefined }),
    setSaveError: (id, message) => patch(id, { saveError: message }),
  }
})
