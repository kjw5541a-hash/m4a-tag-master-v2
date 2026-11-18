// 곡 큐: 파일 읽기 → 자동 조회 → 확인 필요 (기획서 3장 S1, 5.1, 9장). 화면은 이 스토어만 읽고 움직인다.
import { create } from 'zustand'
import { inspect, readTags, Mp4Error } from './mp4.ts'
import { parseSource, type ParsedSource } from './lookup/query.ts'
import { searchItunes, type Candidate } from './lookup/itunes.ts'
import { fetchBytes, LookupError } from './lookup/http.ts'
import { findLyrics } from './lookup/lyrics.ts'
import { applyLyrics, initialEdit, selectCandidate, type Edit, type Source } from './edit.ts'

export type Status = 'reading' | 'searching' | 'review' | 'saved' | 'failed'

export const STATUS_LABEL: Record<Status, string> = {
  reading: '읽는 중',
  searching: '검색 중',
  review: '확인 필요',
  saved: '저장됨',
  failed: '실패',
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
}

interface Queue {
  items: Item[]
  addFiles(files: File[]): { ids: string[]; done: Promise<void> }
  lookup(id: string, query?: string): Promise<void>
  choose(id: string, c: Candidate): Promise<void>
  update(id: string, patch: Partial<Edit>): void
  remove(id: string): void
  markSaved(id: string, savedAs: string): void
}

const lookupMessage = (e: unknown) => (e instanceof LookupError ? e.message : '검색 중 오류가 났어요')

// 커버를 못 받아도 조회는 이어 간다.
const downloadCover = (c: Candidate) => (c.artworkUrl ? fetchBytes(c.artworkUrl).catch(() => undefined) : undefined)

export const useQueue = create<Queue>()((set, get) => {
  const item = (id: string) => get().items.find((i) => i.id === id)
  const patch = (id: string, p: Partial<Item>) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }))
  // 기다리는 사이 사용자가 고친 값을 덮어쓰지 않도록, 조회 결과는 그 시점의 edit에 적용한다.
  const patchEdit = (id: string, fn: (e: Edit) => Edit) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id && i.edit ? { ...i, edit: fn(i.edit) } : i)) }))

  const lyricsFor = async (id: string) => {
    const { source, edit } = item(id) ?? {}
    if (!source || !edit) return
    const r = await findLyrics({ title: edit.title, artist: edit.artist, itunes: edit.candidate, fileDurationSec: source.duration })
    patchEdit(id, (e) => applyLyrics(e, r))
  }

  const load = async (id: string, file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { duration } = inspect(bytes)
      const source: Source = { fileName: file.name, bytes, duration, tags: readTags(bytes) }
      const parsed = parseSource(file.name, source.tags)
      patch(id, { source, parsed, edit: initialEdit(source, parsed), status: 'searching' })
    } catch (e) {
      patch(id, { status: 'failed', error: e instanceof Mp4Error ? e.message : '파일을 읽지 못했어요' })
      return
    }
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
        for (const [i, file] of files.entries()) await load(ids[i]!, file)
      })()
      return { ids, done }
    },

    async lookup(id, query) {
      const { source, parsed } = item(id) ?? {}
      if (!source || !parsed) return
      patch(id, { status: 'searching', error: undefined })
      let error: string | undefined
      try {
        const found = await searchItunes(query ? [query] : parsed.queries)
        const first = found.candidates[0]
        const artwork = first && (await downloadCover(first))
        patchEdit(id, (e) => {
          const next = { ...e, query: found.query, candidates: found.candidates }
          return first ? selectCandidate(next, source, first, artwork) : next
        })
        await lyricsFor(id)
      } catch (e) {
        error = lookupMessage(e)
      }
      patch(id, { status: 'review', error })
    },

    async choose(id, c) {
      const source = item(id)?.source
      if (!source) return
      const artwork = await downloadCover(c)
      patchEdit(id, (e) => selectCandidate(e, source, c, artwork))
      if (item(id)?.edit?.lyricsManual) return
      try {
        await lyricsFor(id)
      } catch (e) {
        patch(id, { error: lookupMessage(e) })
      }
    },

    update: (id, p) => patchEdit(id, (e) => ({ ...e, ...p })),
    remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    markSaved: (id, savedAs) => patch(id, { status: 'saved', savedAs }),
  }
})
