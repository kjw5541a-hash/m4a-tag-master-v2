// D. 가사 시트: LRCLIB 후보 고르기, 붙여넣기, 지우기 (기획서 6.2).
import { useState } from 'react'
import type { Edit } from '../edit.ts'
import { candidateLyrics, splitLyrics } from '../lookup/lyrics.ts'
import { Sheet } from './CandidateSheet.tsx'

interface Props {
  edit: Edit
  onChange(patch: Partial<Edit>): void
  onClose(): void
}

export default function LyricsSheet({ edit, onChange, onClose }: Props) {
  const [text, setText] = useState('')
  // 사용자가 직접 고른 것이므로 이후 자동 채택이 덮어쓰지 않는다.
  const apply = (patch: Pick<Edit, 'lyrics' | 'lrc'>) => {
    onChange({ ...patch, lyricsManual: true })
    onClose()
  }
  const button = 'min-h-11 rounded-lg border border-gray-300 px-4 disabled:opacity-50'

  return (
    <Sheet title="가사" onClose={onClose}>
      <ul>
        {edit.lyricsCandidates.map((c) => {
          const { lyrics, lrc } = candidateLyrics(c)
          const adopted = lyrics === edit.lyrics && lrc === edit.lrc
          return (
            <li key={c.id}>
              <button className="flex min-h-11 w-full items-center gap-3 py-2 text-left" onClick={() => apply({ lyrics, lrc })}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.title}</span>
                  <span className="block truncate text-sm text-gray-500">
                    {[c.artist, c.album].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-gray-500">{adopted ? '✓' : '다른 버전/커버'}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <textarea
        aria-label="가사 붙여넣기"
        rows={6}
        placeholder="가사를 붙여 넣으세요 (싱크 가사도 됩니다)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mt-2 w-full rounded-lg border border-gray-300 p-3 text-base"
      />
      <div className="mt-2 flex gap-2">
        <button className={button} disabled={!text.trim()} onClick={() => apply({ lrc: undefined, ...splitLyrics(text) })}>
          적용
        </button>
        <button className={button} onClick={() => apply({ lyrics: '', lrc: undefined })}>
          지우기
        </button>
      </div>
    </Sheet>
  )
}
