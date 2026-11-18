// 가사 처리·LRCLIB 검색 테스트 (기획서 5.4). 실제 네트워크는 쓰지 않고 fetch를 stub한다.
// fetchJson이 URL별로 캐시하므로 테스트마다 제목·가수를 다르게 쓴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Candidate } from './itunes.ts'
import {
  candidateLyrics,
  findLyrics,
  isLrc,
  pickLyrics,
  splitLyrics,
  stripLrc,
  type LyricsCandidate,
} from './lyrics.ts'
import { LookupError } from './http.ts'
import { stubFetch } from '../testing.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// LRCLIB 응답 한 건
const lrclib = (id: number, artistName: string, duration: number, extra: Record<string, unknown> = {}) => ({
  id,
  trackName: 'x',
  artistName,
  albumName: 'y',
  duration,
  plainLyrics: null,
  syncedLyrics: null,
  ...extra,
})

const cand = (id: number, artist: string, durationSec: number, extra: Partial<LyricsCandidate> = {}): LyricsCandidate => ({
  id,
  artist,
  title: 'x',
  album: 'y',
  durationSec,
  ...extra,
})

const itunes = (over: Partial<Candidate>): Candidate => ({
  trackId: 1,
  title: 'Running on the Sky',
  artist: 'Lee Juck',
  album: '2적',
  durationSec: 263,
  artworkUrl: '',
  ...over,
})

test('isLrc: 비어 있지 않은 줄의 절반 이상이 시간 태그로 시작하면 참', () => {
  assert.equal(isLrc('[00:01.00]a\n[00:02.50]b'), true)
  assert.equal(isLrc('그냥 가사\n[00:01.00]a\nb'), false)
  assert.equal(isLrc(''), false)
})

test('stripLrc: 시간 태그·ID 태그 줄을 지우고 줄 끝·전체 앞뒤 공백을 지운다', () => {
  assert.equal(
    stripLrc('[ar:이적]\n[00:01.00][00:30.00]두근거렸지 \n[00:05.00]\n[00:06.00]누군가'),
    '두근거렸지\n\n누군가',
  )
})

test('stripLrc: 시간 태그 뒤 공백과 태그 앞 공백·BOM도 지운다', () => {
  assert.equal(stripLrc('[00:01.00] a\n[00:02.00] b'), 'a\nb')
  assert.equal(stripLrc('x\n  [00:01.00]y'), 'x\ny')
  assert.equal(stripLrc('﻿[00:01.00] a\n[00:02.00] b'), 'a\nb')
})

test('splitLyrics: LRC면 가사와 lrc를, 아니면 가사만', () => {
  assert.deepEqual(splitLyrics('[00:01.00]가사'), { lyrics: '가사', lrc: '[00:01.00]가사' })
  assert.deepEqual(splitLyrics(' 가사 '), { lyrics: '가사' })
})

test('candidateLyrics: plain 우선, synced만 있으면 타임스탬프를 지운 텍스트', () => {
  assert.deepEqual(candidateLyrics(cand(1, 'a', 1, { plain: '평문', synced: '[00:01.00]동기' })), {
    lyrics: '평문',
    lrc: '[00:01.00]동기',
  })
  assert.deepEqual(candidateLyrics(cand(1, 'a', 1, { synced: '[00:01.00]동기' })), {
    lyrics: '동기',
    lrc: '[00:01.00]동기',
  })
  // LRCLIB 형식 "[mm:ss.xx] 가사": 줄 앞 공백이 남지 않는다
  assert.equal(
    candidateLyrics(cand(1, 'a', 1, { synced: '[00:01.00] 첫 줄\n[00:02.00] 둘째 줄' })).lyrics,
    '첫 줄\n둘째 줄',
  )
})

test('pickLyrics: 가수가 같고 길이 차이가 3초 이내이며 가사가 있는 첫 후보', () => {
  const cands = [
    cand(1, '소향', 255, { plain: 'a' }),
    cand(2, '이적', 297, { plain: 'b' }),
    cand(3, 'Lee Juck', 262, { synced: '[00:01.00]c' }),
    cand(4, '이적', 263, { plain: 'd' }),
    cand(5, '이적', 263),
  ]
  assert.equal(pickLyrics(cands, ['이적', 'Lee Juck'], 263)?.id, 3)
  assert.equal(pickLyrics(cands.slice(0, 2), ['이적'], 263), undefined)
  // 가사 없는 후보는 건너뛴다
  assert.equal(pickLyrics([cands[4]!], ['이적'], 263), undefined)
})

test('findLyrics: get 404 → 첫 search 빈 결과 → iTunes 이름 search에서 채택하고 q= 검색은 하지 않는다', async (t) => {
  const urls = stubFetch(t, (url) => {
    if (url.pathname === '/api/get') return new Response('', { status: 404 })
    if (url.searchParams.get('track_name') === 'Running on the Sky') {
      return json([lrclib(3, 'Lee Juck', 262, { syncedLyrics: '[00:01.00]가사' })])
    }
    return json([])
  })
  const found = await findLyrics({
    title: '하늘을 달리다',
    artist: '이적',
    itunes: itunes({}),
    fileDurationSec: 297,
  })
  assert.equal(found.adopted?.id, 3)
  assert.deepEqual(found.candidates.map((c) => c.id), [3])
  assert.equal(urls.length, 3)
  const [get, byFile, byItunes] = urls.map((u) => new URL(u))
  assert.equal(get!.pathname, '/api/get')
  assert.equal(get!.searchParams.get('duration'), '263')
  assert.ok(urls[0]!.includes(`album_name=${encodeURIComponent('2적')}`))
  assert.equal(byFile!.pathname, '/api/search')
  assert.equal(byFile!.searchParams.get('track_name'), '하늘을 달리다')
  assert.equal(byFile!.searchParams.get('artist_name'), '이적')
  assert.equal(byItunes!.searchParams.get('track_name'), 'Running on the Sky')
  assert.equal(byItunes!.searchParams.get('artist_name'), 'Lee Juck')
  assert.ok(urls.every((u) => !new URL(u).searchParams.has('q')))
})

test('findLyrics: itunes가 없으면 get을 부르지 않고 기준 길이는 파일 길이', async (t) => {
  const urls = stubFetch(t, () => json([lrclib(7, '가수B', 201, { plainLyrics: '가사' })]))
  const found = await findLyrics({ title: '곡B', artist: '가수B', fileDurationSec: 200 })
  assert.equal(found.adopted?.id, 7)
  assert.equal(urls.length, 1)
  assert.equal(new URL(urls[0]!).pathname, '/api/search')
})

test('findLyrics: iTunes 길이가 0(미상)이면 get을 부르지 않고 기준 길이는 파일 길이', async (t) => {
  const urls = stubFetch(t, () => json([lrclib(8, 'Artist C', 201, { plainLyrics: '가사' })]))
  const found = await findLyrics({
    title: '곡C',
    artist: 'Artist C',
    itunes: itunes({ title: '곡C', artist: 'Artist C', durationSec: 0 }),
    fileDurationSec: 200,
  })
  assert.equal(found.adopted?.id, 8)
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ['/api/search'])
})

test('findLyrics: 채택할 것이 없으면 후보만 돌려주고 id로 중복을 없앤다', async (t) => {
  const urls = stubFetch(t, () => json([lrclib(9, '다른가수', 200, { plainLyrics: '가사' })]))
  const found = await findLyrics({ title: '곡D', artist: '가수D', fileDurationSec: 200 })
  assert.equal(found.adopted, undefined)
  assert.deepEqual(found.candidates.map((c) => c.id), [9])
  // 제목·가수 search 한 번 + q= search 한 번 (iTunes 없으니 iTunes 이름 검색 없음)
  assert.equal(urls.length, 2)
  assert.equal(new URL(urls[1]!).searchParams.get('q'), '가수D 곡D')
})

test('findLyrics: 요청 하나가 실패해도 다음 요청으로 이어 가고 채택하면 오류 없이 끝난다', async (t) => {
  const urls = stubFetch(t, (url) =>
    url.pathname === '/api/get' ? new Response('', { status: 503 }) : json([lrclib(21, 'Artist E', 201, { plainLyrics: '가사' })]),
  )
  const found = await findLyrics({
    title: '곡E',
    artist: 'Artist E',
    itunes: itunes({ title: '곡E', artist: 'Artist E', album: '앨범E', durationSec: 200 }),
    fileDurationSec: 200,
  })
  assert.equal(found.adopted?.id, 21)
  assert.equal(new URL(urls[0]!).pathname, '/api/get')
  assert.equal(new URL(urls[1]!).pathname, '/api/search')
})

test('findLyrics: 모든 요청이 실패하면 마지막 오류를 던진다', async (t) => {
  stubFetch(t, () => Promise.reject(new TypeError('fetch failed')))
  await assert.rejects(
    findLyrics({ title: '곡F', artist: 'Artist F', fileDurationSec: 200 }),
    (e) => e instanceof LookupError && e.message === '검색 실패 (네트워크)',
  )
})
