// 검색어 정리 (기획서 5.2): 지저분한 유튜브 파일명·태그 → 표시용 가수/제목 + iTunes 검색어(최대 3개).
// 순수 함수. normalizeName은 가수 이름 비교용(Task 4).

export interface ParsedSource {
  artist: string
  title: string
  queries: string[]
}

/** 라틴 표기와 한글 표기. 없는 쪽은 빈 문자열. */
interface Names {
  latin: string
  hangul: string
}

const hasHangul = (s: string) => /\p{Script=Hangul}/u.test(s)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

// 채널 접두: 1theK는 괄호 병기("1theK (원더케이)")까지 포함한다.
const CHANNEL_PREFIX =
  /^(?:1theK(?:\s*\([^)]*\))?|Stone Music Entertainment|HYBE LABELS|SMTOWN|JYP Entertainment|YG ENTERTAINMENT|CJENMMUSIC|KBS Kpop|Mnet K-POP)\s-\s/iu

// 잡음 단어. \b는 한글을 단어로 치지 않으므로 유니코드 lookaround로 경계를 잡는다("4Kings"의 4K는 남는다).
const NOISE =
  String.raw`(?<![\p{L}\p{N}_])(?:MV|M/V|Official|Music Video|Video|Audio|Lyrics|Lyric|가사|4K|HD)(?![\p{L}\p{N}_])`
const NOISE_WORD = new RegExp(NOISE, 'iu')
const NOISE_ALL = new RegExp(NOISE, 'giu')

const SEPARATORS = [' - ', ' _ ', ' | ']
const QUOTED = /'([^']+)'|"([^"]+)"|‘([^’]+)’|“([^”]+)”/u

/** 잡음 단어가 든 [..] (..) 【..】 묶음을 통째로, 그다음 떨어진 잡음 단어를 지운다. */
function stripNoise(s: string): string {
  const noBrackets = s.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/gu, (m) =>
    NOISE_WORD.test(m) ? '' : m,
  )
  return squash(noBrackets.replace(NOISE_ALL, ' '))
}

/** 첫 구분자로 [가수, 제목]을 나눈다. 구분자도 따옴표도 없으면 전체가 제목. */
function splitArtistTitle(s: string, fallbackArtist: string): [string, string] {
  let at = -1
  let len = 0
  for (const sep of SEPARATORS) {
    const i = s.indexOf(sep)
    if (i >= 0 && (at < 0 || i < at)) {
      at = i
      len = sep.length
    }
  }
  if (at >= 0) return [s.slice(0, at), s.slice(at + len)]
  const q = QUOTED.exec(s)
  if (q) return [s.slice(0, q.index), q.slice(1).find(Boolean) ?? '']
  return [fallbackArtist, s]
}

/** 라틴/한글 표기로 나눈다. X(Y)는 한쪽에만 한글일 때, 괄호 없는 가수는 토큰을 글자 종류별로 묶는다. */
function splitScript(raw: string, isArtist: boolean): Names {
  const s = squash(raw)
  const paren = /^([^()]+?)\s*\(([^()]+)\)$/.exec(s)
  if (paren) {
    const x = paren[1].trim()
    const y = paren[2].trim()
    if (hasHangul(x) !== hasHangul(y)) {
      return hasHangul(x) ? { hangul: x, latin: y } : { hangul: y, latin: x }
    }
  }
  if (isArtist && !/[()]/.test(s)) {
    const tokens = s.split(' ')
    const hangul = tokens.filter(hasHangul)
    const latin = tokens.filter((t) => !hasHangul(t))
    if (hangul.length && latin.length) return { hangul: hangul.join(' '), latin: latin.join(' ') }
  }
  return hasHangul(s) ? { latin: '', hangul: s } : { latin: s, hangul: '' }
}

const pick = (n: Names) => n.hangul || n.latin

export function parseSource(
  fileName: string,
  tags: { title?: string; artist?: string },
): ParsedSource {
  const tagArtist = (tags.artist ?? '').normalize('NFC').trim()
  let input: string
  let dupNo = ''
  if (tags.title) {
    input = tags.title.normalize('NFC')
  } else {
    input = fileName.normalize('NFC').replace(/\.\w+$/, '')
    const dup = /\s(\d+)$/.exec(input)
    if (dup) {
      dupNo = dup[1]
      input = input.slice(0, dup.index)
    }
    input = tagArtist && input.startsWith(`${tagArtist} - `)
      ? input.slice(tagArtist.length + 3)
      : input.replace(CHANNEL_PREFIX, '')
  }

  const [artistRaw, titleRaw] = splitArtistTitle(stripNoise(input), tagArtist)
  const artist = splitScript(artistRaw, true)
  const title = splitScript(titleRaw, false)

  const queries = [
    // 라틴 검색어: 제목에 라틴 표기가 있고, 가수도 라틴 표기가 있거나 아예 비어 있을 때
    title.latin && (artist.latin || !artist.hangul) ? `${artist.latin} ${title.latin}` : '',
    `${pick(artist)} ${pick(title)}`,
    dupNo ? `${pick(artist)} ${pick(title)} ${dupNo}` : '',
  ]
    .map(squash)
    .filter((q, i, all) => q && all.indexOf(q) === i)
    .slice(0, 3)

  return { artist: squash(pick(artist)), title: squash(pick(title)), queries }
}

/** 이름 비교용: NFC → 소문자 → 공백·구두점·기호 제거. */
export function normalizeName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}
