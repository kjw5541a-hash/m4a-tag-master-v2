// 네트워크 도우미·iTunes 검색 테스트 (기획서 5.3, 8.4). 실제 네트워크는 쓰지 않고 fetch를 stub한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LookupError, fetchJson, limiter } from './http.ts'
import { parseItunes, searchItunes } from './itunes.ts'
import { stubFetch } from '../testing.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const RESPONSE = {
  resultCount: 4,
  results: [
    {
      trackId: 1,
      artistName: 'Lee Juck',
      trackName: 'Running on the Sky',
      collectionName: '2적',
      trackTimeMillis: 263000,
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg',
    },
    {
      trackId: 1,
      artistName: 'Lee Juck',
      trackName: 'Running on the Sky (dup)',
      collectionName: '2적',
      trackTimeMillis: 263000,
    },
    {
      trackId: 2,
      artistName: 'Lee Juck',
      trackName: 'Run Across the Sky',
      collectionName: 'Do You Remember',
      trackTimeMillis: 265000,
    },
    { artistName: 'x' },
  ],
}

const EXPECTED = [
  {
    trackId: 1,
    title: 'Running on the Sky',
    artist: 'Lee Juck',
    album: '2적',
    durationSec: 263,
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/a/1000x1000bb.jpg',
  },
  {
    trackId: 2,
    title: 'Run Across the Sky',
    artist: 'Lee Juck',
    album: 'Do You Remember',
    durationSec: 265,
    artworkUrl: '',
  },
]

test('parseItunes: 순서 유지, trackId 중복 제거, trackId·trackName 없는 결과 버림', () => {
  assert.deepEqual(parseItunes(RESPONSE), EXPECTED)
})

test('parseItunes: 형식이 다른 응답은 빈 배열', () => {
  assert.deepEqual(parseItunes(null), [])
  assert.deepEqual(parseItunes({}), [])
})

test('searchItunes: 결과가 나오는 검색어에서 멈추고 URL 매개변수를 담는다', async (t) => {
  const urls = stubFetch(t, (url) =>
    url.searchParams.get('term') === '없는곡' ? json({ resultCount: 0, results: [] }) : json(RESPONSE),
  )
  const queries = ['없는곡', 'Lee Juck running on the sky']
  const found = await searchItunes(queries)
  assert.equal(found.query, queries[1])
  assert.deepEqual(found.candidates, EXPECTED)
  assert.equal(urls.length, 2)
  for (const [i, u] of urls.entries()) {
    for (const part of ['entity=song', 'limit=10', 'country=US', `term=${encodeURIComponent(queries[i]!)}`]) {
      assert.ok(u.includes(part), `${u} 에 ${part} 가 있어야 한다`)
    }
  }
})

test('searchItunes: 모두 0건이면 첫 검색어와 빈 후보', async (t) => {
  stubFetch(t, () => json({ resultCount: 0, results: [] }))
  assert.deepEqual(await searchItunes(['zero-a', 'zero-b']), { query: 'zero-a', candidates: [] })
  assert.deepEqual(await searchItunes([]), { query: '', candidates: [] })
})

test('fetchJson: 같은 URL은 한 번만 요청한다', async (t) => {
  const urls = stubFetch(t, () => json({ ok: 1 }))
  assert.deepEqual(await fetchJson('https://example.test/cache'), { ok: 1 })
  assert.deepEqual(await fetchJson('https://example.test/cache'), { ok: 1 })
  assert.equal(urls.length, 1)
})

test('fetchJson: 404는 null이고 캐시하지 않는다', async (t) => {
  const urls = stubFetch(t, () => new Response('', { status: 404 }))
  assert.equal(await fetchJson('https://example.test/missing'), null)
  assert.equal(await fetchJson('https://example.test/missing'), null)
  assert.equal(urls.length, 2)
})

test('fetchJson: 404 외의 비정상 응답은 LookupError', async (t) => {
  stubFetch(t, () => new Response('', { status: 503 }))
  await assert.rejects(fetchJson('https://example.test/down'), (e: unknown) => {
    assert.ok(e instanceof LookupError)
    assert.equal(e.message, '검색 실패 (503)')
    return true
  })
})

test('fetchJson: 처음 한 번 실패하면 재시도해서 성공한다', async (t) => {
  let calls = 0
  stubFetch(t, () => {
    if (++calls === 1) throw new TypeError('fetch failed')
    return json({ ok: 2 })
  })
  assert.deepEqual(await fetchJson('https://example.test/retry'), { ok: 2 })
  assert.equal(calls, 2)
})

test('fetchJson: 두 번 다 실패하면 LookupError(네트워크)', async (t) => {
  let calls = 0
  stubFetch(t, () => {
    calls++
    throw new TypeError('fetch failed')
  })
  await assert.rejects(fetchJson('https://example.test/offline'), (e: unknown) => {
    assert.ok(e instanceof LookupError)
    assert.equal(e.message, '검색 실패 (네트워크)')
    return true
  })
  assert.equal(calls, 2)
})

test('limiter: 창 안에 max번 통과하면 가장 오래된 통과가 빠질 때까지 기다린다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const wait = limiter(2, 1000)
  await wait()
  await wait()
  let passed = false
  const third = wait().then(() => {
    passed = true
  })
  t.mock.timers.tick(999)
  await new Promise((r) => setImmediate(r))
  assert.equal(passed, false)
  t.mock.timers.tick(1)
  await third
  assert.equal(passed, true)
})
