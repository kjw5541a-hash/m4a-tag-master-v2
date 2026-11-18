// A. 큐: 파일 추가와 곡 카드 목록 (기획서 6.1).
import { useEffect, useState, type ChangeEvent } from 'react'
import { STATUS_LABEL, useQueue } from '../store.ts'

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
    <main className="space-y-4">
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
                <span className="block text-sm text-gray-700">{STATUS_LABEL[item.status]}</span>
                {item.error && <span className="block text-sm text-red-600">{item.error}</span>}
              </span>
            </button>
            <button aria-label="삭제" className="size-11 shrink-0 text-gray-500" onClick={() => remove(item.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <small className="block text-gray-500">빌드 {__BUILD_ID__}</small>
    </main>
  )
}
