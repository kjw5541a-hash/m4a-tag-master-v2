// A. 큐: 파일 추가와 곡 카드 목록 (기획서 6.1).
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { buildBatch, saveErrorMessage, SHARE_BATCH, shareOrDownload, type Built } from '../save.ts'
import { saveAllTargets, statusLabel, useQueue } from '../store.ts'

// 커버 바이트를 object URL로 보여 주고, 바뀌거나 사라지면 URL을 반납한다.
export function CoverThumb({ bytes, className }: { bytes?: Uint8Array; className: string }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    // 바이트는 새로 읽은 ArrayBuffer 위에 있으므로 BlobPart 타입에 맞춰 좁힌다.
    const u = bytes && URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]))
    setUrl(u)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [bytes])
  return url ? (
    <img src={url} alt="" className={`${className} object-cover`} />
  ) : (
    <div className={`${className} bg-gray-200`} />
  )
}

export default function QueueScreen({ onOpen }: { onOpen(id: string): void }) {
  const items = useQueue((s) => s.items)
  const addFiles = useQueue((s) => s.addFiles)
  const remove = useQueue((s) => s.remove)
  const removeSaved = useQueue((s) => s.removeSaved)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string>()
  // 공유가 끝나지 않은 묶음. 다시 누르면 바뀌지 않은 곡은 다시 만들지 않는다.
  const lastBatch = useRef<Built[]>([])
  const { ready, busy } = saveAllTargets(items)
  const savedCount = items.filter((i) => i.status === 'saved').length

  // 클릭 핸들러 안에서 await 없이 파일을 만들고 바로 공유를 연다. 그래야 공유 권한(사용자 제스처)이 유지된다.
  function saveAll() {
    const { markSaved, setSaveError } = useQueue.getState()
    const batch = ready.slice(0, SHARE_BATCH).map((i) => ({ id: i.id, source: i.source!, edit: i.edit! }))
    const { built, failed } = buildBatch(batch, lastBatch.current)
    lastBatch.current = built
    // 검증에 실패한 곡만 빼고 나머지를 저장한다.
    for (const f of failed) setSaveError(f.id, `저장을 막았어요(원본은 안전해요): ${f.message}`)
    if (built.length === 0) return
    setNotice(undefined)
    setSaving(true)
    shareOrDownload(built.map((b) => b.file))
      .then((r) => {
        if (r === 'cancelled') return
        for (const b of built) markSaved(b.id, b.file)
        lastBatch.current = []
      })
      .catch((err: unknown) => setNotice(saveErrorMessage(err)))
      .finally(() => setSaving(false))
  }

  function add(e: ChangeEvent<HTMLInputElement>) {
    // 값을 비우면 FileList도 비므로 먼저 복사한다. 비워 두어야 같은 파일을 다시 고를 수 있다.
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const { ids } = addFiles(files)
    // 한 곡이면 바로 편집 화면으로, 여러 곡이면 큐에 남는다.
    if (ids.length === 1) onOpen(ids[0]!)
  }

  return (
    // 남은 높이를 채워 빌드 표시를 화면 맨 아래에 붙인다.
    <main className="flex flex-1 flex-col space-y-4">
      <h1 className="text-xl font-bold">M4A Tag Master</h1>
      <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl bg-blue-600 px-4 font-medium text-white">
        <input type="file" accept=".m4a,audio/mp4,audio/x-m4a" multiple hidden onChange={add} />
        ＋ 파일 추가
      </label>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-1 rounded-xl border border-gray-200 p-2">
            <button
              className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
              disabled={!item.edit}
              onClick={() => onOpen(item.id)}
            >
              <CoverThumb bytes={item.edit?.cover} className="size-14 shrink-0 rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.edit?.title || item.fileName}</span>
                <span className="block truncate text-sm text-gray-500">
                  {[item.edit?.artist, item.edit?.album].filter(Boolean).join(' · ')}
                </span>
                <span className="block text-sm text-gray-700">{statusLabel(item)}</span>
                {item.error && <span className="block text-sm text-red-600">{item.error}</span>}
                {item.saveError && <span className="block text-sm text-red-600">{item.saveError}</span>}
              </span>
            </button>
            <button aria-label="삭제" className="size-11 shrink-0 text-gray-500" onClick={() => remove(item.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {(ready.length > 0 || busy) && (
        <div className="space-y-1">
          <button
            className="min-h-12 w-full rounded-xl bg-blue-600 font-medium text-white disabled:opacity-50"
            disabled={busy || saving || ready.length === 0}
            onClick={saveAll}
          >
            {ready.length > SHARE_BATCH ? `${SHARE_BATCH}곡 저장 (남은 ${ready.length}곡)` : `모두 저장 (${ready.length}곡)`}
          </button>
          {busy && <p className="text-center text-sm text-gray-500">분석이 끝나면 저장할 수 있어요</p>}
          {notice && <p className="text-center text-sm text-red-600">{notice}</p>}
        </div>
      )}
      {savedCount > 0 && (
        <button className="min-h-11 w-full rounded-xl border border-gray-300 text-gray-700" onClick={removeSaved}>
          {`저장된 곡 지우기 (${savedCount}곡)`}
        </button>
      )}
      <small className="mt-auto block text-gray-500">빌드 {__BUILD_ID__}</small>
    </main>
  )
}
