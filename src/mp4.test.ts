// MP4 태그 엔진 테스트. 테스트 파일은 ffmpeg로 그때그때 만든다(실제 곡은 저장소에 넣지 않는다).
// 기준(오라클): 디코드한 PCM이 원본과 같은지(ffmpeg), 다른 파서로 태그가 읽히는지(music-metadata = 웹 MAPP).
// 실제 파일 점검: REAL_M4A_DIR=<m4a가 든 폴더> npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBuffer } from 'music-metadata'
import { inspect, readTags, writeTags, verify, Mp4Error, type Tags } from './mp4.ts'
import { ffmpeg, makeImage, makeM4a } from './testing.ts'

const dir = mkdtempSync(join(tmpdir(), 'mp4-test-'))
let fileNo = 0

/** 디코드한 PCM의 해시. 청크 오프셋이 하나라도 틀리면 달라지거나 ffmpeg가 오류를 낸다. */
function pcmHash(bytes: Uint8Array): string {
  const file = join(dir, `pcm-${fileNo++}.m4a`)
  writeFileSync(file, bytes)
  return createHash('sha256').update(ffmpeg('-i', file, '-f', 's16le', '-')).digest('hex')
}

const jpeg = makeImage(32, 32, 'mjpeg')
const png = makeImage(32, 32, 'png')
const coverFile = join(dir, 'cover.jpg')
writeFileSync(coverFile, jpeg)

const fullTags: Tags = {
  title: '하늘을 달리다',
  artist: '이적',
  album: '2적',
  lyrics: '두근거렸지\n누군가 나의 뒤를 쫓고 있었고',
  cover: jpeg,
  analysis: JSON.stringify({ version: 1, bpm: 113, key: 'F', scale: 'minor' }),
  lrc: '[00:01.00]두근거렸지',
}

/** 쓰고, 자체 검증하고, PCM과 music-metadata로 교차 확인한다. music-metadata의 iTunes 태그를 돌려준다. */
async function roundTrip(orig: Uint8Array, tags: Tags) {
  const out = writeTags(orig, tags)
  verify(orig, out, tags)
  assert.equal(pcmHash(out), pcmHash(orig), '오디오가 달라졌다')
  const mm = await parseBuffer(out, 'audio/mp4')
  const native = new Map(mm.native.iTunes.map((t) => [t.id, t.value]))
  const text = { '©nam': tags.title, '©ART': tags.artist, '©alb': tags.album, '©lyr': tags.lyrics,
    '----:com.jw.mapp:ANALYSIS': tags.analysis, '----:com.jw.mapp:LRC': tags.lrc }
  for (const [id, want] of Object.entries(text)) assert.equal(native.get(id), want || undefined, id)
  const cover = native.get('covr') as { data: Uint8Array } | undefined
  assert.deepEqual(cover && new Uint8Array(cover.data), tags.cover)
  return { out, native }
}

test('faststart, 태그 없음: udta/meta/ilst를 만들고 뒤쪽 청크 오프셋을 옮긴다', async () => {
  const orig = makeM4a('-movflags', '+faststart')
  assert.deepEqual(readTags(orig), {})
  const { out } = await roundTrip(orig, fullTags)
  assert.ok(out.length > orig.length)
  assert.deepEqual(readTags(out), fullTags)
})

test('moov가 mdat 뒤에 있으면 오프셋을 바꾸지 않아도 된다', async () => {
  await roundTrip(makeM4a(), fullTags)
})

test('yt-dlp 형태: 관리하지 않는 태그는 남기고, 빈 값은 지운다', async () => {
  const orig = makeM4a('-i', coverFile, '-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'title=Lee Juck(이적) _ running on the sky', '-metadata', 'artist=1theK (원더케이)',
    '-metadata', 'album=1theK (원더케이)', '-movflags', '+faststart')
  const before = readTags(orig)
  assert.equal(before.album, '1theK (원더케이)')
  assert.deepEqual(before.cover, jpeg)

  const tags: Tags = { title: '하늘을 달리다', artist: '이적', album: '', cover: png }
  const { native } = await roundTrip(orig, tags)
  assert.ok(native.has('©too'), '인코더 태그(©too)가 지워졌다')
  assert.ok(!native.has('©alb'), '빈 앨범이 남아 있다')
})

test('co64(64비트 청크 오프셋)도 옮긴다', async () => {
  const base = makeM4a('-movflags', '+faststart')
  const orig = toCo64(base)
  assert.equal(pcmHash(orig), pcmHash(base), '테스트용 co64 파일이 잘못 만들어졌다')
  await roundTrip(orig, fullTags)
})

test('두 번 써도 결과가 같다', () => {
  const once = writeTags(makeM4a('-movflags', '+faststart'), fullTags)
  assert.equal(Buffer.compare(writeTags(once, fullTags), once), 0)
})

test('inspect: 길이를 구하고, 지원하지 않는 파일은 이유와 함께 거부한다', () => {
  assert.ok(Math.abs(inspect(makeM4a()).duration - 3) < 0.1)
  const reason = (bytes: Uint8Array) => {
    try {
      inspect(bytes)
    } catch (e) {
      assert.ok(e instanceof Mp4Error, String(e))
      return e.message
    }
    assert.fail('거부하지 않았다')
  }
  assert.match(reason(makeM4a('-movflags', 'frag_keyframe+empty_moov')), /분할 MP4/)
  assert.match(reason(new Uint8Array(1000).fill(7)), /손상/)
  assert.match(reason(makeM4a().subarray(0, 500)), /손상/)
})

test('실제 m4a 파일 (REAL_M4A_DIR이 있을 때만)', { skip: !process.env.REAL_M4A_DIR }, async () => {
  const realDir = process.env.REAL_M4A_DIR!
  for (const name of readdirSync(realDir).filter((n) => n.endsWith('.m4a'))) {
    const orig = new Uint8Array(readFileSync(join(realDir, name)))
    inspect(orig)
    const tags = { ...readTags(orig), title: '테스트 제목', album: '', analysis: fullTags.analysis, lrc: fullTags.lrc }
    await roundTrip(orig, tags)
  }
})

/** faststart 파일의 stco를 co64로 바꾼다. moov가 4×n 바이트 커지므로 오프셋에도 그만큼 더한다. */
function toCo64(b: Uint8Array): Uint8Array {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const find = (type: string, from: number, to: number) => {
    for (let p = from; p < to; p += v.getUint32(p)) {
      if (String.fromCharCode(...b.subarray(p + 4, p + 8)) === type) return p
    }
    throw new Error(`${type} 없음`)
  }
  const ancestors = [find('moov', 0, b.length)]
  for (const type of ['trak', 'mdia', 'minf', 'stbl']) {
    const p = ancestors.at(-1)!
    ancestors.push(find(type, p + 8, p + v.getUint32(p)))
  }
  const stbl = ancestors.at(-1)!
  const stco = find('stco', stbl + 8, stbl + v.getUint32(stbl))
  const n = v.getUint32(stco + 12)
  const grow = 4 * n
  const co64 = new Uint8Array(16 + 8 * n)
  const cv = new DataView(co64.buffer)
  cv.setUint32(0, co64.length)
  co64.set([0x63, 0x6f, 0x36, 0x34], 4) // 'co64'
  cv.setUint32(12, n)
  for (let i = 0; i < n; i++) cv.setBigUint64(16 + 8 * i, BigInt(v.getUint32(stco + 16 + 4 * i) + grow))
  const out = new Uint8Array(b.length + grow)
  out.set(b.subarray(0, stco))
  out.set(co64, stco)
  out.set(b.subarray(stco + 16 + 4 * n), stco + co64.length)
  const ov = new DataView(out.buffer)
  for (const p of ancestors) ov.setUint32(p, ov.getUint32(p) + grow)
  return out
}
