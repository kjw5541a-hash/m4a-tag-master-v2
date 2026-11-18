// 편집 모델·출력 파일 이름·이미지 크기 테스트 (기획서 5.3 표기 정책, 5.6 9번).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readTags, type Tags } from './mp4.ts'
import type { Candidate } from './lookup/itunes.ts'
import type { LyricsCandidate } from './lookup/lyrics.ts'
import { imageSize, isSquare } from './cover.ts'
import { applyLyrics, formatDiff, initialEdit, outputName, selectCandidate, toTags, type Source } from './edit.ts'
import { buildOutput } from './save.ts'
import { makeImage, makeM4a } from './testing.ts'

const wide = makeImage(1280, 720, 'mjpeg')
const square = makeImage(32, 32, 'png')

const source = (tags: Tags, bytes: Uint8Array = new Uint8Array(), fileName = 'a.m4a'): Source => ({ fileName, bytes, duration: 3, tags })

// yt-dlp가 만든 파일의 태그와 parseSource 결과
const ytTags: Tags = {
  title: 'Lee Juck(이적) _ running on the sky(하늘을 달리다)',
  artist: '1theK (원더케이)',
  album: '1theK (원더케이)',
  cover: wide,
}
const parsed = { artist: '이적', title: '하늘을 달리다', queries: ['Lee Juck running on the sky', '이적 하늘을 달리다'] }

// v2가 이미 저장한 파일의 태그
const v2Tags: Tags = {
  title: '하늘을 달리다',
  artist: '이적',
  album: '2적',
  lyrics: '가사',
  lrc: '[00:01.00]가사',
  analysis: '{"version":1}',
}

const candidate: Candidate = { trackId: 1, title: '하늘을 달리다', artist: '이적', album: '2적', durationSec: 263, artworkUrl: '' }

test('imageSize: PNG는 IHDR, JPEG는 SOF에서 읽고 그 밖은 undefined', () => {
  assert.deepEqual(imageSize(wide), { width: 1280, height: 720 })
  assert.deepEqual(imageSize(square), { width: 32, height: 32 })
  assert.equal(imageSize(new Uint8Array(100).fill(7)), undefined)
  assert.equal(isSquare(wide), false)
  assert.equal(isSquare(square), true)
})

test('initialEdit: yt-dlp 형태는 채널명 앨범을 비우고 기존 커버를 둔다', () => {
  const e = initialEdit(source(ytTags), parsed)
  assert.equal(e.title, '하늘을 달리다')
  assert.equal(e.artist, '이적')
  assert.equal(e.album, '')
  assert.equal(e.lyrics, '')
  assert.equal(e.lyricsManual, false)
  assert.equal(e.query, 'Lee Juck running on the sky')
  assert.equal(e.cover, wide)
  assert.deepEqual(e.candidates, [])
  assert.deepEqual(e.lyricsCandidates, [])
})

test('selectCandidate: 기존 커버가 정사각형이 아니면 artwork, 정사각형이면 기존 커버', () => {
  const e = initialEdit(source(ytTags), parsed)
  const picked = selectCandidate(e, source(ytTags), candidate, square)
  assert.equal(picked.cover, square)
  assert.equal(picked.album, '2적')
  assert.equal(picked.candidate, candidate)

  const tags = { ...ytTags, cover: square }
  const kept = selectCandidate(initialEdit(source(tags), parsed), source(tags), candidate, makeImage(64, 64, 'png'))
  assert.equal(kept.cover, square)

  // artwork를 받지 못했으면 기존 커버를 그대로 둔다
  assert.equal(selectCandidate(e, source(ytTags), candidate).cover, wide)
})

test('initialEdit: v2 출력 형태는 앨범·가사를 지키고 자동 가사로 덮지 않는다', () => {
  const e = initialEdit(source(v2Tags), parsed)
  assert.equal(e.album, '2적')
  assert.equal(e.lyrics, '가사')
  assert.equal(e.lrc, '[00:01.00]가사')
  assert.equal(e.lyricsManual, true)
  const adopted: LyricsCandidate = { id: 1, artist: '이적', title: 'x', album: 'y', durationSec: 263, plain: '다른 가사', synced: '[00:02.00]다른 가사' }
  const after = applyLyrics(e, { adopted, candidates: [adopted] })
  assert.equal(after.lyrics, '가사')
  assert.equal(after.lrc, '[00:01.00]가사')
  assert.deepEqual(after.lyricsCandidates, [adopted])
})

test('applyLyrics: 직접 고치지 않았으면 채택한 가사의 일반·싱크 가사를 넣는다', () => {
  const e = initialEdit(source(ytTags), parsed)
  const adopted: LyricsCandidate = { id: 1, artist: '이적', title: 'x', album: 'y', durationSec: 263, plain: '일반', synced: '[00:01.00]싱크' }
  const after = applyLyrics(e, { adopted, candidates: [adopted] })
  assert.equal(after.lyrics, '일반')
  assert.equal(after.lrc, '[00:01.00]싱크')
  // 채택한 후보가 없으면 후보 목록만 바뀐다
  const none = applyLyrics(e, { candidates: [adopted] })
  assert.equal(none.lyrics, '')
  assert.deepEqual(none.lyricsCandidates, [adopted])
})

test('toTags: 기존 분석값을 지키며 편집값을 태그로 바꾼다', () => {
  const src = source(v2Tags)
  const tags = toTags(initialEdit(src, parsed), src)
  assert.equal(tags.analysis, '{"version":1}')
  assert.equal(tags.title, '하늘을 달리다')
  assert.equal(tags.album, '2적')
  assert.equal(tags.lrc, '[00:01.00]가사')
})

test('outputName: 가수 - 제목.m4a, 금지 문자 삭제, NFC, 120자', () => {
  const name = (artist: string, title: string, original = 'x.m4a') =>
    outputName({ ...initialEdit(source({}), { artist: '', title: '', queries: [] }), artist, title }, original)
  assert.equal(name('이적', '하늘을 달리다'), '이적 - 하늘을 달리다.m4a')
  assert.equal(name('', '산책'), '산책.m4a')
  assert.equal(name('', '', '김동률 - 산책 2.m4a'), '김동률 - 산책 2.m4a')
  assert.equal(name('AC/DC', 'What? "Now"'), 'ACDC - What Now.m4a')
  assert.equal(name('이적'.normalize('NFD'), '하늘을 달리다'.normalize('NFD')), '이적 - 하늘을 달리다.m4a')
  assert.equal(name('', '', '산책 2.m4a'.normalize('NFD')), '산책 2.m4a')
  assert.equal(name('', '가'.repeat(200)).slice(0, -4).length, 120)
})

test('formatDiff: 반올림하고 부호를 붙인다', () => {
  assert.equal(formatDiff(-34.2), '−34초')
  assert.equal(formatDiff(3), '+3초')
  assert.equal(formatDiff(0.4), '0초')
})

test('buildOutput: 태그를 쓰고 검증한 새 File을 돌려준다', async () => {
  const bytes = makeM4a('-metadata', 'title=x', '-movflags', '+faststart')
  const src = source(readTags(bytes), bytes)
  const e = { ...initialEdit(source(ytTags), parsed), title: '하늘을 달리다', artist: '이적', cover: square }
  const file = buildOutput(src, e)
  assert.equal(file.name, '이적 - 하늘을 달리다.m4a')
  assert.equal(file.type, 'audio/mp4')
  // 빈 필드는 없는 것으로 본다
  const present = (t: Tags) => Object.fromEntries(Object.entries(t).filter(([, v]) => v?.length))
  assert.deepEqual(present(readTags(new Uint8Array(await file.arrayBuffer()))), present(toTags(e, src)))
})
