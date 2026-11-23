// B. 곡 편집: 한 곡의 정보를 확인하고 고쳐서 저장한다 (기획서 6.2, 5.7).
import { useId, useRef, useState } from 'react'
import { cropSquareJpeg, isSquare } from '../cover.ts'
import { formatDiff } from '../edit.ts'
import { fetchBytes } from '../lookup/http.ts'
import { buildOutput, saveErrorMessage, shareOrDownload } from '../save.ts'
import { STATUS_LABEL, statusLabel, useQueue } from '../store.ts'
import AnalysisCard from './AnalysisCard.tsx'
import CandidateSheet from './CandidateSheet.tsx'
import LyricsSheet from './LyricsSheet.tsx'
import { CoverThumb } from './QueueScreen.tsx'

const button = 'min-h-11 min-w-11 rounded-lg border border-gray-300 px-3 text-sm disabled:opacity-50'
const input = 'min-h-11 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-base disabled:opacity-50'

// 값 입력란. original·itunes가 있으면 그 값으로 바꾸는 버튼을 붙인다.
function Field(p: { label: string; value: string; onChange(v: string): void; original?: string; itunes?: string }) {
  const id = useId()
  const pick = (name: string, v?: string) =>
    v === undefined ? null : (
      <button aria-pressed={p.value === v} className={`${button} aria-pressed:bg-gray-200`} onClick={() => p.onChange(v)}>
        {name}
      </button>
    )
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-10 shrink-0 text-gray-500">
        {p.label}
      </label>
      <input id={id} className={input} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      {pick('원본', p.original)}
      {pick('iTunes', p.itunes)}
    </div>
  )
}

interface Notice {
  text: string
  diag?: string
  copied?: boolean
}

export default function EditScreen({ id, onBack }: { id: string; onBack(): void }) {
  const item = useQueue((s) => s.items.find((i) => i.id === id)!)
  const { lookup, choose, update, markSaved } = useQueue.getState()
  const [sheet, setSheet] = useState<'candidates' | 'lyrics'>()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  // 만든 파일을 편집값(글자 필드 JSON + 커버 참조)과 함께 둔다. 같으면 두 번째 탭에서 다시 만들지 않는다.
  const built = useRef<{ key: string; cover?: Uint8Array; file: File }>(undefined)

  const { edit: e, source: src, parsed } = item
  // 읽는 중이거나 검색 중이면 입력을 잠가, 늦게 온 조회 결과가 사용자가 친 값을 덮어쓰지 않게 한다.
  const locked = item.status === 'searching' || item.status === 'reading'
  const status = locked ? `${STATUS_LABEL[item.status]}…` : statusLabel(item)

  const header = (
    <header className="flex items-center justify-between">
      <button className="min-h-11 min-w-11 pr-3 text-left" onClick={onBack}>
        ‹ 큐
      </button>
      <span className="text-sm text-gray-600">{status}</span>
    </header>
  )
  if (!e || !src || !parsed) {
    return (
      <main className="space-y-4">
        {header}
        {item.error && <p className="text-red-600">{item.error}</p>}
      </main>
    )
  }

  const setCover = (cover: Promise<Uint8Array>) =>
    cover.then(
      (c) => update(id, { cover: c }),
      () => setNotice({ text: '커버를 불러오지 못했어요' }),
    )
  const original = src.tags.cover
  // 분석이 끝나야 저장한다. 안 그러면 분석이 빠진 파일이 나간다.
  const analyzing = item.analysisJob?.state === 'waiting' || item.analysisJob?.state === 'running'
  const diff = (sec: number) => (sec > 0 ? ` · ${formatDiff(sec - src.duration)}` : '')

  // 클릭 핸들러 안에서 await 없이 파일을 만들고 바로 공유를 연다. 그래야 공유 권한(사용자 제스처)이 유지된다.
  const save = () => {
    const key = JSON.stringify([e.title, e.artist, e.album, e.lyrics, e.lrc, e.analysis])
    let file = built.current?.key === key && built.current.cover === e.cover ? built.current.file : undefined
    if (!file) {
      try {
        file = buildOutput(src, e)
        built.current = { key, cover: e.cover, file }
      } catch (err) {
        setNotice({ text: '저장을 막았어요(원본은 안전해요)', diag: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    const saved = file
    setNotice(undefined)
    setSaving(true)
    shareOrDownload([saved])
      .then((r) => {
        if (r !== 'cancelled') markSaved(id, saved.name)
      })
      // 만든 파일은 그대로 두므로 다시 누르면 바로 공유가 열린다.
      .catch((err: unknown) => setNotice({ text: saveErrorMessage(err) }))
      .finally(() => setSaving(false))
  }

  return (
    <main className="space-y-4 pb-36">
      {header}
      <fieldset disabled={locked} className="min-w-0 space-y-4">
        <div className="flex flex-col items-center gap-2">
          <CoverThumb bytes={e.cover} className="size-40 rounded-xl" />
          <div className="flex flex-wrap justify-center gap-2">
            {e.candidate?.artworkUrl && (
              // ponytail: 받는 사이 다른 후보를 고르면 이 커버가 덮어쓴다. 필요해지면 요청 번호로 거르기.
              <button className={button} onClick={() => setCover(fetchBytes(e.candidate!.artworkUrl))}>
                iTunes 커버
              </button>
            )}
            {original && (
              <button className={button} onClick={() => update(id, { cover: original })}>
                기존 커버
              </button>
            )}
            {original && !isSquare(original) && (
              <button className={button} onClick={() => setCover(cropSquareJpeg(original))}>
                정사각형으로 자르기
              </button>
            )}
          </div>
        </div>

        <form
          className="flex items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault()
            void lookup(id, e.query)
          }}
        >
          <input aria-label="검색어" enterKeyHint="search" className={input} value={e.query} onChange={(ev) => update(id, { query: ev.target.value })} />
          <button type="submit" aria-label="검색" className={button}>
            🔍
          </button>
        </form>

        <button
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 p-3 text-left disabled:opacity-50"
          disabled={e.candidates.length === 0}
          onClick={() => setSheet('candidates')}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{e.candidate?.title ?? '후보 없음'}</span>
            {e.candidate && (
              <span className="block truncate text-sm text-gray-500">
                {e.candidate.artist} · {e.candidate.album}
                {diff(e.candidate.durationSec)}
              </span>
            )}
          </span>
          <span aria-hidden>›</span>
        </button>

        <Field label="제목" value={e.title} onChange={(v) => update(id, { title: v })} original={parsed.title} itunes={e.candidate?.title} />
        <Field label="가수" value={e.artist} onChange={(v) => update(id, { artist: v })} original={parsed.artist} itunes={e.candidate?.artist} />
        <button className={button} onClick={() => update(id, { title: e.artist, artist: e.title })}>
          가수⇄제목
        </button>
        <Field label="앨범" value={e.album} onChange={(v) => update(id, { album: v })} />

        <button
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 p-3 text-left disabled:opacity-50"
          onClick={() => setSheet('lyrics')}
        >
          <span className="min-w-0 flex-1">
            <span className="block">{`가사  일반 ${e.lyrics ? '✓' : '없음'} · 싱크 ${e.lrc ? '✓' : '없음'}`}</span>
            <span className="block truncate text-sm text-gray-500">{e.lyrics.split('\n').find((l) => l.trim())}</span>
          </span>
          <span aria-hidden>›</span>
        </button>

        <AnalysisCard id={id} job={item.analysisJob} analysis={e.analysis} />

        {item.error && (
          <div className="flex items-center gap-2">
            <p className="flex-1 text-red-600">{item.error}</p>
            <button className={button} onClick={() => void lookup(id)}>
              다시 시도
            </button>
          </div>
        )}

        <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
          <div className="mx-auto max-w-xl space-y-2">
            {notice && (
              <p className="text-sm text-red-600">
                {notice.text}
                {notice.diag !== undefined && (
                  <button
                    className="ml-2 min-h-11 underline"
                    onClick={() =>
                      navigator.clipboard.writeText(notice.diag!).then(
                        () => setNotice({ ...notice, copied: true }),
                        () => setNotice({ ...notice, text: `${notice.text} · 복사하지 못했어요` }),
                      )
                    }
                  >
                    {notice.copied ? '복사했어요' : '진단 정보 복사'}
                  </button>
                )}
              </p>
            )}
            <button className="min-h-12 w-full rounded-xl bg-blue-600 font-medium text-white disabled:opacity-50" disabled={saving || analyzing} onClick={save}>
              {analyzing ? '분석 기다리는 중…' : '저장 · 공유'}
            </button>
          </div>
        </div>
      </fieldset>

      {sheet === 'candidates' && (
        <CandidateSheet
          candidates={e.candidates}
          durationSec={src.duration}
          onChoose={(c) => {
            void choose(id, c)
            setSheet(undefined)
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'lyrics' && <LyricsSheet edit={e} onChange={(p) => update(id, p)} onClose={() => setSheet(undefined)} />}
    </main>
  )
}
