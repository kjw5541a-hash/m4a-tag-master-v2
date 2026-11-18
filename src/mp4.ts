// m4a(MP4) 컨테이너: 구조 검사, iTunes 태그 읽기·쓰기, 쓰기 결과 자체 검증.
// 오디오 데이터(mdat)는 그대로 두고 moov/udta/meta/ilst만 다시 만든 뒤, 밀린 청크 오프셋을 고친다.

export interface Tags {
  title?: string // ©nam
  artist?: string // ©ART
  album?: string // ©alb
  lyrics?: string // ©lyr, 타임스탬프 없는 일반 가사
  cover?: Uint8Array // covr, JPEG 또는 PNG 원본 바이트
  analysis?: string // ----:com.jw.mapp:ANALYSIS, JSON 문자열
  lrc?: string // ----:com.jw.mapp:LRC, 싱크 가사 원문
}

/** 사용자에게 그대로 보여 줄 거부 사유 */
export class Mp4Error extends Error {}

const MAX_BYTES = 200 * 2 ** 20
const TEXT = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©lyr': 'lyrics' } as const
const MEAN = 'com.jw.mapp'
const FREEFORM = { ANALYSIS: 'analysis', LRC: 'lrc' } as const
const KEYS = ['title', 'artist', 'album', 'lyrics', 'cover', 'analysis', 'lrc'] as const

interface Box {
  type: string
  start: number
  end: number
  body: number // 헤더 바로 뒤
}

const corrupt = () => new Mp4Error('m4a 파일이 아니거나 손상됐어요')
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const fourcc = (b: Uint8Array, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])
const utf8 = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)

/** [from, to) 구간의 박스들. 크기가 범위를 벗어나면 손상으로 본다. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const v = dv(b)
  const out: Box[] = []
  for (let p = from; p < to; ) {
    if (to - p < 8) throw corrupt()
    let size = v.getUint32(p)
    let header = 8
    if (size === 1) {
      if (to - p < 16) throw corrupt()
      size = Number(v.getBigUint64(p + 8))
      header = 16
    } else if (size === 0) {
      size = to - p // 부모 끝까지
    }
    if (size < header || p + size > to) throw corrupt()
    out.push({ type: fourcc(b, p + 4), start: p, end: p + size, body: p + header })
    p += size
  }
  return out
}

/** 자식 박스가 시작하는 위치. iTunes meta는 FullBox(버전·플래그 4바이트)라 한 칸 뒤에서 시작한다. */
function contentStart(b: Uint8Array, box: Box) {
  return box.type === 'meta' && fourcc(b, box.body + 4) !== 'hdlr' ? box.body + 4 : box.body
}

const children = (b: Uint8Array, box: Box) => boxes(b, contentStart(b, box), box.end)

function path(b: Uint8Array, box: Box | undefined, ...types: string[]): Box | undefined {
  for (const type of types) box = box && children(b, box).find((c) => c.type === type)
  return box
}

function moovOf(b: Uint8Array): Box {
  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov')
  if (!moov) throw corrupt()
  return moov
}

/** 모든 트랙의 stco/co64 항목 위치 */
function* offsetSlots(b: Uint8Array, moov: Box) {
  for (const trak of children(b, moov).filter((c) => c.type === 'trak')) {
    const stbl = path(b, trak, 'mdia', 'minf', 'stbl')
    for (const t of stbl ? children(b, stbl) : []) {
      if (t.type !== 'stco' && t.type !== 'co64') continue
      const wide = t.type === 'co64'
      const n = dv(b).getUint32(t.body + 4)
      for (let i = 0; i < n; i++) yield { pos: t.body + 8 + i * (wide ? 8 : 4), wide }
    }
  }
}

const readSlot = (v: DataView, s: { pos: number; wide: boolean }) =>
  s.wide ? Number(v.getBigUint64(s.pos)) : v.getUint32(s.pos)

/** 구조를 검사하고 오디오 길이(초)를 돌려준다. 지원하지 않으면 Mp4Error. */
export function inspect(b: Uint8Array): { duration: number } {
  if (b.length > MAX_BYTES) throw new Mp4Error('200MB보다 큰 파일은 지원하지 않아요')
  const top = boxes(b, 0, b.length)
  if (top.some((x) => x.type === 'moof')) {
    throw new Mp4Error('이 형식(분할 MP4)은 지원하지 않아요. ffmpeg로 `-c copy` 재다중화한 뒤 다시 넣어 주세요')
  }
  const moovs = top.filter((x) => x.type === 'moov')
  if (!top.some((x) => x.type === 'ftyp') || !top.some((x) => x.type === 'mdat') || moovs.length !== 1) throw corrupt()

  const unsupported = new Mp4Error('오디오 트랙이 하나인 AAC·ALAC m4a만 지원해요')
  const sound = children(b, moovs[0])
    .filter((c) => c.type === 'trak')
    .filter((t) => {
      const hdlr = path(b, t, 'mdia', 'hdlr')
      return hdlr && fourcc(b, hdlr.body + 8) === 'soun'
    })
  if (sound.length !== 1) throw unsupported
  const stsd = path(b, sound[0], 'mdia', 'minf', 'stbl', 'stsd')
  if (!stsd || !['mp4a', 'alac'].includes(fourcc(b, stsd.body + 12))) throw unsupported

  const mdhd = path(b, sound[0], 'mdia', 'mdhd')
  if (!mdhd) throw corrupt()
  const v = dv(b)
  const [timescale, duration] =
    b[mdhd.body] === 1
      ? [v.getUint32(mdhd.body + 20), Number(v.getBigUint64(mdhd.body + 24))]
      : [v.getUint32(mdhd.body + 12), v.getUint32(mdhd.body + 16)]
  if (!timescale) throw corrupt()
  return { duration: duration / timescale }
}

function ilstOf(b: Uint8Array): Box | undefined {
  return path(b, moovOf(b), 'udta', 'meta', 'ilst')
}

/** '----' 아톰의 "mean:name" */
function freeformKey(b: Uint8Array, item: Box): string {
  const kids = boxes(b, item.body, item.end)
  const part = (type: string) => {
    const k = kids.find((c) => c.type === type)
    return k ? text(b.subarray(k.body + 4, k.end)) : ''
  }
  return `${part('mean')}:${part('name')}`
}

/** 관리 대상 아톰이면 Tags의 필드 이름, 아니면 undefined */
function fieldOf(b: Uint8Array, item: Box): keyof Tags | undefined {
  if (item.type in TEXT) return TEXT[item.type as keyof typeof TEXT]
  if (item.type === 'covr') return 'cover'
  if (item.type !== '----') return undefined
  const [mean, name] = freeformKey(b, item).split(':')
  return mean === MEAN ? FREEFORM[name as keyof typeof FREEFORM] : undefined
}

export function readTags(b: Uint8Array): Tags {
  const tags: Tags = {}
  const ilst = ilstOf(b)
  for (const item of ilst ? boxes(b, ilst.body, ilst.end) : []) {
    const field = fieldOf(b, item)
    const data = field && boxes(b, item.body, item.end).find((c) => c.type === 'data')
    if (!field || !data) continue
    const value = b.slice(data.body + 8, data.end) // 타입 4바이트 + 로케일 4바이트 뒤
    if (field === 'cover') tags.cover = value
    else tags[field] = text(value)
  }
  return tags
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  dv(out).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let p = 8
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

const u32 = (n: number) => {
  const a = new Uint8Array(4)
  dv(a).setUint32(0, n)
  return a
}
const dataBox = (type: number, value: Uint8Array) => box('data', u32(type), u32(0), value)
const fullBox = (type: string, payload: Uint8Array) => box(type, u32(0), payload)
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

/** 값이 있는 관리 대상 아톰들. 빈 값은 만들지 않는다(= 지운다). */
function managedItems(tags: Tags): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const [atom, field] of Object.entries(TEXT)) {
    const v = tags[field]
    if (v) out.push(box(atom, dataBox(1, utf8(v))))
  }
  if (tags.cover?.length) out.push(box('covr', dataBox(isPng(tags.cover) ? 14 : 13, tags.cover)))
  for (const [name, field] of Object.entries(FREEFORM)) {
    const v = tags[field]
    if (v) out.push(box('----', fullBox('mean', utf8(MEAN)), fullBox('name', utf8(name)), dataBox(1, utf8(v))))
  }
  return out
}

/** parent를 다시 만든다. type 자식은 make의 결과로 바꾸고, 없으면 끝에 붙인다. 나머지 자식은 그대로 둔다. */
function rebuild(b: Uint8Array, parent: Box, type: string, make: (old?: Box) => Uint8Array): Uint8Array {
  const start = contentStart(b, parent)
  const kids = boxes(b, start, parent.end)
  const old = kids.find((c) => c.type === type)
  const fresh = make(old)
  const parts = kids.map((c) => (c === old ? fresh : b.subarray(c.start, c.end)))
  if (!old) parts.push(fresh)
  return box(parent.type, b.subarray(parent.body, start), ...parts) // meta의 버전·플래그도 그대로
}

const HDLR = box('hdlr', u32(0), u32(0), utf8('mdir'), utf8('appl'), u32(0), u32(0), new Uint8Array(1))

/** 관리 대상 태그를 tags대로 바꾼 새 파일을 만든다. tags에 없거나 빈 필드는 파일에서 지운다. */
export function writeTags(b: Uint8Array, tags: Tags): Uint8Array {
  const moov = moovOf(b)
  const ilst = (old?: Box) =>
    box('ilst',
      ...(old ? boxes(b, old.body, old.end).filter((c) => !fieldOf(b, c)).map((c) => b.subarray(c.start, c.end)) : []),
      ...managedItems(tags))
  const meta = (old?: Box) => (old ? rebuild(b, old, 'ilst', ilst) : box('meta', u32(0), HDLR, ilst()))
  const udta = (old?: Box) => (old ? rebuild(b, old, 'meta', meta) : box('udta', meta()))
  const fresh = rebuild(b, moov, 'udta', udta)

  // moov 뒤에 있던 청크는 moov가 커진(줄어든) 만큼 밀린다
  const delta = fresh.length - (moov.end - moov.start)
  const v = dv(fresh)
  for (const s of offsetSlots(fresh, boxes(fresh, 0, fresh.length)[0])) {
    const x = readSlot(v, s)
    if (x < moov.end) continue
    if (s.wide) v.setBigUint64(s.pos, BigInt(x + delta))
    else v.setUint32(s.pos, x + delta) // 200MB 상한이라 32비트를 넘지 않는다. 넘으면 verify가 잡는다
  }

  const out = new Uint8Array(b.length + delta)
  out.set(b.subarray(0, moov.start))
  out.set(fresh, moov.start)
  out.set(b.subarray(moov.end), moov.start + fresh.length)
  return out
}

function chunkOffsets(b: Uint8Array): number[] {
  const v = dv(b)
  return [...offsetSlots(b, moovOf(b))].map((s) => readSlot(v, s))
}

const same = (a?: Uint8Array | string, b?: Uint8Array | string) =>
  typeof a === 'string' || typeof b === 'string'
    ? a === b
    : a?.length === b?.length && (!a || a.every((x, i) => x === b![i]))

/** 쓰기 결과 자체 검증. 구조, 모든 청크 앞부분 바이트, 태그 값을 확인하고 어긋나면 진단 메시지와 함께 던진다. */
export function verify(orig: Uint8Array, out: Uint8Array, tags: Tags): void {
  inspect(out)
  const a = chunkOffsets(orig)
  const c = chunkOffsets(out)
  if (a.length !== c.length) throw new Error(`청크 개수가 다름: ${a.length} → ${c.length}`)
  for (let i = 0; i < a.length; i++) {
    if (!same(orig.subarray(a[i], a[i] + 16), out.subarray(c[i], c[i] + 16))) {
      throw new Error(`청크 ${i} 데이터가 다름: 오프셋 ${a[i]} → ${c[i]}`)
    }
  }
  const got = readTags(out)
  for (const k of KEYS) {
    const want = tags[k]?.length ? tags[k] : undefined
    if (!same(want, got[k])) throw new Error(`태그 ${k}가 기대값과 다름`)
  }
}
