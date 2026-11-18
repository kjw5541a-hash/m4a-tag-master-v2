// 곡 하나의 편집 상태 (기획서 5.3 표기 정책). 화면 없이 값이 어떻게 바뀌는지만 다룬다.
import type { Tags } from './mp4.ts'
import type { ParsedSource } from './lookup/query.ts'
import type { Candidate } from './lookup/itunes.ts'
import { candidateLyrics, type LyricsCandidate } from './lookup/lyrics.ts'
import { isSquare } from './cover.ts'

export interface Source {
  fileName: string
  bytes: Uint8Array
  duration: number
  tags: Tags
}

export interface Edit {
  query: string
  candidates: Candidate[]
  candidate?: Candidate
  title: string
  artist: string
  album: string
  lyrics: string
  lrc?: string
  // 기존 가사가 있거나 사용자가 고쳤으면 자동 채택이 덮어쓰지 않는다.
  lyricsManual: boolean
  lyricsCandidates: LyricsCandidate[]
  cover?: Uint8Array
}

export function initialEdit(src: Source, parsed: ParsedSource): Edit {
  const { tags } = src
  const lyrics = tags.lyrics ?? ''
  return {
    query: parsed.queries[0] ?? '',
    candidates: [],
    title: parsed.title,
    artist: parsed.artist,
    // 앨범이 가수와 같으면 유튜브 채널명이 남은 것이다.
    album: tags.album === tags.artist ? '' : (tags.album ?? ''),
    lyrics,
    lrc: tags.lrc,
    lyricsManual: lyrics !== '' || !!tags.lrc,
    lyricsCandidates: [],
    cover: tags.cover,
  }
}

// 기존 정사각형 커버는 지키고, 아니면 iTunes 아트워크로 바꾼다.
export function selectCandidate(e: Edit, src: Source, c: Candidate, artwork?: Uint8Array): Edit {
  const old = src.tags.cover
  return { ...e, candidate: c, album: c.album, cover: old && isSquare(old) ? old : (artwork ?? old) }
}

export function applyLyrics(e: Edit, r: { adopted?: LyricsCandidate; candidates: LyricsCandidate[] }): Edit {
  const next = { ...e, lyricsCandidates: r.candidates }
  return !e.lyricsManual && r.adopted ? { ...next, ...candidateLyrics(r.adopted) } : next
}

// 분석값(analysis)은 M3 전까지 만들지 않으므로 기존 값을 그대로 보존한다.
export function toTags(e: Edit, src: Source): Tags {
  const { title, artist, album, lyrics, lrc, cover } = e
  return { title, artist, album, lyrics, lrc, cover, analysis: src.tags.analysis }
}

// 파일명에 못 쓰는 문자를 지우고 NFC로 맞춘다.
const clean = (s: string) => s.normalize('NFC').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim()

export function outputName(e: Edit, originalName: string): string {
  const artist = clean(e.artist)
  const title = clean(e.title)
  const base = title ? (artist ? `${artist} - ${title}` : title) : clean(originalName.replace(/\.\w+$/, ''))
  // 코드포인트 단위로 잘라 서로게이트 쌍(이모지)이 쪼개지지 않게 한다.
  return `${[...base].slice(0, 120).join('').trimEnd()}.m4a`
}

export function formatDiff(sec: number): string {
  const n = Math.round(sec)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}초`
}
