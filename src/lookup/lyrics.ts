// 가사: LRC 처리 + LRCLIB 검색·채택 (기획서 5.4).
import { fetchJson, LookupError } from './http.ts'
import type { Candidate } from './itunes.ts'
import { normalizeName } from './query.ts'

export interface LyricsCandidate {
  id: number
  artist: string
  title: string
  album: string
  durationSec: number
  plain?: string
  synced?: string
}

// 줄 앞에 연달아 붙은 시간 태그. 예: [00:01.00][00:30.00]
const TIME_TAGS = /^(?:\[\d+:\d{2}(?:\.\d+)?\])+/
// [ar:…] [offset:…] 같은 ID 태그 줄
const ID_TAG_LINE = /^\[[a-z]+:.*\]$/i

const lines = (text: string) => text.split(/\r?\n/)

// 비어 있지 않은 줄의 절반 이상이 시간 태그로 시작하면 LRC.
export function isLrc(text: string): boolean {
  const filled = lines(text).map((l) => l.trim()).filter(Boolean)
  return filled.length > 0 && filled.filter((l) => TIME_TAGS.test(l)).length * 2 >= filled.length
}

export function stripLrc(lrc: string): string {
  return lines(lrc)
    .filter((l) => !ID_TAG_LINE.test(l.trim()))
    // 태그 앞(공백·BOM)과 "[mm:ss.xx] 가사"의 태그 뒤 공백까지 지운다.
    .map((l) => l.trim().replace(TIME_TAGS, '').trim())
    .join('\n')
    .trim()
}

// 붙여넣기용.
export function splitLyrics(text: string): { lyrics: string; lrc?: string } {
  return isLrc(text) ? { lyrics: stripLrc(text), lrc: text.trim() } : { lyrics: text.trim() }
}

export function candidateLyrics(c: LyricsCandidate): { lyrics: string; lrc?: string } {
  return { lyrics: c.plain ?? stripLrc(c.synced ?? ''), lrc: c.synced }
}

// 가수가 같고 길이 차이가 3초 이내이며 가사가 있는 첫 후보.
export function pickLyrics(
  cands: LyricsCandidate[],
  artistNames: string[],
  refDurationSec: number,
): LyricsCandidate | undefined {
  const names = artistNames.map(normalizeName)
  return cands.find(
    (c) =>
      names.includes(normalizeName(c.artist)) &&
      Math.abs(c.durationSec - refDurationSec) <= 3 &&
      (c.plain || c.synced),
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
// null·빈 문자열은 가사 없음.
const lyric = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

// get은 객체 하나, search는 배열. id 없는 항목은 버린다.
function parseLrclib(json: unknown): LyricsCandidate[] {
  const items = Array.isArray(json) ? json : json ? [json] : []
  return (items as Record<string, unknown>[]).flatMap((r) =>
    typeof r.id === 'number'
      ? [
          {
            id: r.id,
            artist: str(r.artistName),
            title: str(r.trackName),
            album: str(r.albumName),
            durationSec: typeof r.duration === 'number' ? r.duration : 0,
            plain: lyric(r.plainLyrics),
            synced: lyric(r.syncedLyrics),
          },
        ]
      : [],
  )
}

const api = (path: string, params: Record<string, string>) =>
  `https://lrclib.net/api/${path}?${Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')}`

export interface LyricsQuery {
  title: string
  artist: string
  itunes?: Candidate
  fileDurationSec: number
}

// get → 검색(파일 이름) → 검색(iTunes 이름) → q= 검색 순으로, 채택할 것이 생기면 멈춘다. 요청 하나가 실패해도 다음으로 넘어간다.
export async function findLyrics(
  q: LyricsQuery,
): Promise<{ adopted?: LyricsCandidate; candidates: LyricsCandidate[] }> {
  const it = q.itunes
  // iTunes 길이 0은 미상. LRCLIB get에는 진짜 길이가 필요하다.
  const refDurationSec = it?.durationSec || q.fileDurationSec
  const artistNames = [q.artist, it?.artist].filter((n): n is string => !!n)
  const urls = [
    it && it.durationSec > 0
      ? api('get', {
          track_name: it.title,
          artist_name: it.artist,
          album_name: it.album,
          duration: String(Math.round(it.durationSec)),
        })
      : '',
    api('search', { track_name: q.title, artist_name: q.artist }),
    it && (it.title !== q.title || it.artist !== q.artist)
      ? api('search', { track_name: it.title, artist_name: it.artist })
      : '',
    api('search', { q: `${q.artist} ${q.title}`.trim() }),
  ].filter(Boolean)

  const candidates: LyricsCandidate[] = []
  let failure: LookupError | undefined
  let succeeded = false
  for (const url of urls) {
    let body: unknown
    try {
      body = await fetchJson(url)
    } catch (e) {
      // 한 요청이 실패해도 다음 검색으로 이어 간다.
      if (!(e instanceof LookupError)) throw e
      failure = e
      continue
    }
    succeeded = true
    for (const c of parseLrclib(body)) {
      if (!candidates.some((x) => x.id === c.id)) candidates.push(c)
    }
    const adopted = pickLyrics(candidates, artistNames, refDurationSec)
    if (adopted) return { adopted, candidates }
  }
  // 모든 요청이 실패했으면 오프라인 같은 사정이니 화면에 오류로 알린다.
  if (!succeeded && failure) throw failure
  return { candidates }
}
