// C. 후보 시트: iTunes 후보 목록 (기획서 6.2). 시트 겉모양(Sheet)은 D 시트도 쓴다.
import type { ReactNode } from 'react'
import { formatDiff } from '../edit.ts'
import type { Candidate } from '../lookup/itunes.ts'

// 아래에서 올라오는 시트. 바깥을 누르면 닫는다.
export function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 flex items-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[80dvh] w-full overflow-y-auto rounded-t-2xl bg-white pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] transition-transform duration-200 starting:translate-y-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-bold">{title}</h2>
          <button aria-label="닫기" className="size-11" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

interface Props {
  candidates: Candidate[]
  durationSec: number
  onChoose(c: Candidate): void
  onClose(): void
}

export default function CandidateSheet({ candidates, durationSec, onChoose, onClose }: Props) {
  return (
    <Sheet title="후보 선택" onClose={onClose}>
      <ul>
        {candidates.map((c) => (
          <li key={c.trackId}>
            <button className="flex min-h-11 w-full items-center gap-3 py-2 text-left" onClick={() => onChoose(c)}>
              {c.artworkUrl ? (
                <img src={c.artworkUrl.replace('1000x1000bb', '100x100bb')} alt="" className="size-14 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="size-14 shrink-0 rounded-lg bg-gray-200" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.title}</span>
                <span className="block truncate text-sm text-gray-500">
                  {[c.artist, c.album, c.durationSec > 0 && formatDiff(c.durationSec - durationSec)].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
