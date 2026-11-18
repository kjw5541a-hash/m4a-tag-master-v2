// 큐 스토어 테스트 (기획서 3장 S1, 5.1, 9장). 실제 네트워크는 쓰지 않고 fetch를 stub한다.
// 조회 결과가 URL별로 세션 캐시되므로 테스트마다 제목·검색어를 다르게 한다.
// iTunes 호출 제한(분당 20회)은 이 파일 안에서 공유된다. 지금 18회라, 조회를 더하면 제한에 걸려 한참 기다린다.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { useQueue } from './store.ts'
import { makeImage, makeM4a, stubFetch } from './testing.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// makeImage·makeM4a는 새로 읽은 ArrayBuffer라 BodyInit·BlobPart 타입에 맞춰 좁힌다.
const PNG = makeImage(32, 32, 'png') as Uint8Array<ArrayBuffer>

const ITUNES = {
  resultCount: 2,
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
      trackId: 2,
      artistName: 'Lee Juck',
      trackName: 'Run Across the Sky',
      collectionName: 'Do You Remember',
      trackTimeMillis: 265000,
    },
  ],
}

const LRCLIB_HIT = {
  id: 7,
  artistName: '이적',
  trackName: '하늘을 달리다',
  albumName: '2적',
  duration: 263,
  plainLyrics: '두근거렸지',
  syncedLyrics: '[00:01.00]두근거렸지',
}

interface Stub {
  itunes?: (term: string) => unknown | Promise<unknown>
  artwork?: (url: URL) => Response | Promise<Response>
  search?: unknown[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// iTunes·아트워크·LRCLIB를 한꺼번에 흉내 낸다. LRCLIB get은 항상 404.
function stubAll(t: TestContext, { itunes = () => ITUNES, artwork = () => new Response(PNG), search = [] }: Stub = {}) {
  return stubFetch(t, async (url) => {
    if (url.hostname === 'itunes.apple.com') return json(await itunes(url.searchParams.get('term')!))
    if (url.hostname === 'is1-ssl.mzstatic.com') return artwork(url)
    if (url.pathname === '/api/get') return new Response('', { status: 404 })
    return json(search)
  })
}

const m4a = (name: string, ...args: string[]) => new File([makeM4a(...args) as Uint8Array<ArrayBuffer>], name)

const find = (id: string) => useQueue.getState().items.find((i) => i.id === id)!

async function add(file: File) {
  useQueue.setState({ items: [] })
  const { ids, done } = useQueue.getState().addFiles([file])
  assert.equal(find(ids[0]!).status, 'reading')
  await done
  return ids[0]!
}

test('yt-dlp 형태 한 곡: 읽기 → 검색 → 커버 → 가사 → 확인 필요', async (t) => {
  const urls = stubAll(t, { search: [LRCLIB_HIT] })
  const file = m4a(
    '1theK (원더케이) - Lee Juck(이적) _ running on the sky(하늘을 달리다).m4a',
    '-metadata', 'title=Lee Juck(이적) _ running on the sky(하늘을 달리다)',
    '-metadata', 'artist=1theK (원더케이)',
    '-metadata', 'album=1theK (원더케이)',
    '-movflags', '+faststart',
  )
  const id = await add(file)
  const item = find(id)
  assert.equal(item.status, 'review')
  assert.equal(item.error, undefined)
  const e = item.edit!
  assert.equal(e.title, '하늘을 달리다')
  assert.equal(e.artist, '이적')
  assert.equal(e.album, '2적')
  assert.deepEqual(e.cover, PNG)
  assert.equal(e.lyrics, '두근거렸지')
  assert.equal(e.lrc, '[00:01.00]두근거렸지')
  assert.equal(new URL(urls[0]!).searchParams.get('term'), 'Lee Juck running on the sky')
})

test('m4a가 아닌 파일은 실패로 끝나고 이유를 보여 준다', async () => {
  const id = await add(new File([new Uint8Array(1000).fill(7)], 'x.m4a'))
  const item = find(id)
  assert.equal(item.status, 'failed')
  assert.match(item.error!, /손상/)
})

test('실패한 파일이 있어도 다음 파일은 계속 처리한다', async (t) => {
  stubAll(t, { itunes: () => ({ results: [] }) })
  useQueue.setState({ items: [] })
  const bad = new File([new Uint8Array(1000).fill(7)], 'bad.m4a')
  const { ids, done } = useQueue.getState().addFiles([bad, m4a('Seq Band - Seq Song.m4a')])
  await done
  assert.deepEqual(ids.map((i) => find(i).status), ['failed', 'review'])
})

test('검색 결과가 0건이면 후보 없이 파싱 결과로 확인 필요', async (t) => {
  stubAll(t, { itunes: () => ({ resultCount: 0, results: [] }) })
  const id = await add(m4a('Zero Band - Zero Song.m4a'))
  const item = find(id)
  assert.equal(item.status, 'review')
  assert.equal(item.error, undefined)
  assert.equal(item.edit!.candidate, undefined)
  assert.equal(item.edit!.title, 'Zero Song')
  assert.equal(item.edit!.artist, 'Zero Band')
})

test('네트워크가 끊기면 오류를 기록하고 확인 필요, 다시 조회하면 오류를 지운다', async (t) => {
  let down = true
  stubFetch(t, () => (down ? Promise.reject(new TypeError('fetch failed')) : json({ results: [] })))
  const id = await add(m4a('Down Band - Down Song.m4a'))
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).error, '검색 실패 (네트워크)')
  down = false
  await useQueue.getState().lookup(id)
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).error, undefined)
})

test('lookup(id, 검색어): 그 검색어 하나만 찾고 edit.query로 남긴다', async (t) => {
  const urls = stubAll(t, { itunes: (term) => (term === '수정한 검색어' ? { results: [{ ...ITUNES.results[1], trackId: 9 }] } : ITUNES) })
  const id = await add(m4a('Query Band - Query Song.m4a'))
  urls.length = 0
  await useQueue.getState().lookup(id, '수정한 검색어')
  const terms = urls.filter((u) => u.includes('itunes.apple.com')).map((u) => new URL(u).searchParams.get('term'))
  assert.deepEqual(terms, ['수정한 검색어'])
  assert.equal(find(id).edit!.query, '수정한 검색어')
  assert.equal(find(id).edit!.candidate!.trackId, 9)
})

test('choose: 받는 동안 검색 중으로 잠기고, 앨범이 바뀌고, 가사를 직접 고쳤으면 가사를 다시 찾지 않는다', async (t) => {
  let artworkDelay = 0
  // 두 번째 후보에도 아트워크가 있어야 선택할 때 다운로드가 일어난다.
  const withArt = { ...ITUNES.results[1], artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/b/100x100bb.jpg' }
  const urls = stubAll(t, {
    itunes: () => ({ results: [ITUNES.results[0], withArt] }),
    artwork: async () => (await sleep(artworkDelay), new Response(PNG)),
  })
  const id = await add(m4a('Choose Band - Choose Song.m4a'))
  const other = find(id).edit!.candidates[1]!
  urls.length = 0
  artworkDelay = 300
  // 아트워크를 받는 동안 화면이 잠겨야, 그 사이 저장이 옛 후보의 값을 쓰고 '저장됨'으로 표시되지 않는다.
  const pending = useQueue.getState().choose(id, other)
  assert.equal(find(id).status, 'searching')
  await sleep(20)
  assert.equal(find(id).status, 'searching')
  assert.equal(find(id).edit!.candidate!.trackId, 1)
  await pending
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).edit!.candidate!.trackId, 2)
  assert.equal(find(id).edit!.album, 'Do You Remember')
  assert.ok(urls.some((u) => u.includes('lrclib.net')), '가사를 다시 찾아야 한다')

  useQueue.getState().update(id, { lyricsManual: true })
  urls.length = 0
  await useQueue.getState().choose(id, find(id).edit!.candidates[0]!)
  assert.equal(find(id).edit!.album, '2적')
  assert.deepEqual(urls.filter((u) => u.includes('lrclib.net')), [])
})

test('커버 다운로드가 실패해도 조회는 커버 없이 이어진다', async (t) => {
  stubAll(t, { artwork: () => new Response('', { status: 500 }) })
  const id = await add(m4a('Art Band - Art Song.m4a'))
  const item = find(id)
  assert.equal(item.status, 'review')
  assert.equal(item.error, undefined)
  assert.equal(item.edit!.album, '2적')
  assert.equal(item.edit!.cover, undefined)
})

test('update·markSaved·remove', async (t) => {
  stubAll(t, { itunes: () => ({ results: [] }) })
  const id = await add(m4a('Misc Band - Misc Song.m4a'))
  const { update, markSaved, remove } = useQueue.getState()
  update(id, { title: '고친 제목' })
  assert.equal(find(id).edit!.title, '고친 제목')
  markSaved(id, 'a.m4a')
  assert.equal(find(id).status, 'saved')
  assert.equal(find(id).savedAs, 'a.m4a')
  // 저장 뒤 검색어만 고치면 파일과 화면이 그대로라 저장됨을 유지하고, 다른 값을 고치면 확인 필요로 돌아간다.
  update(id, { query: '검색어만' })
  assert.equal(find(id).status, 'saved')
  update(id, { title: '저장 뒤에 고친 제목' })
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).savedAs, 'a.m4a')
  remove(id)
  assert.deepEqual(useQueue.getState().items, [])
})

test('느린 조회가 나중에 끝나도 더 새 조회의 결과를 덮어쓰지 않는다', async (t) => {
  const one = (trackId: number) => ({ results: [{ ...ITUNES.results[1], trackId }] })
  stubAll(t, {
    itunes: async (term) => {
      if (term !== 'slowq' && term !== 'fastq') return ITUNES
      if (term === 'slowq') await sleep(150)
      return one(term === 'slowq' ? 101 : 102)
    },
  })
  const id = await add(m4a('Stale Band - Stale Song.m4a'))
  const slow = useQueue.getState().lookup(id, 'slowq')
  await useQueue.getState().lookup(id, 'fastq')
  await slow
  assert.equal(find(id).edit!.candidate!.trackId, 102)
  assert.equal(find(id).edit!.query, 'fastq')
  assert.equal(find(id).status, 'review')
})

test('조회 중에 저장 표시를 하면 조회가 끝나도 저장됨으로 남는다', async (t) => {
  stubAll(t, {
    itunes: async (term) => {
      if (term === 'savedq') await sleep(100)
      return ITUNES
    },
  })
  const id = await add(m4a('Saved Band - Saved Song.m4a'))
  const pending = useQueue.getState().lookup(id, 'savedq')
  useQueue.getState().markSaved(id, 'out.m4a')
  await pending
  assert.equal(find(id).status, 'saved')
  assert.equal(find(id).savedAs, 'out.m4a')
})

test('조회 중에 후보를 고르면 그 조회는 버려지고 검색 중이 끝난다', async (t) => {
  stubAll(t, {
    itunes: async (term) => {
      if (term === 'busyq') await sleep(100)
      return ITUNES
    },
  })
  const id = await add(m4a('Busy Band - Busy Song.m4a'))
  const busy = useQueue.getState().lookup(id, 'busyq')
  await useQueue.getState().choose(id, find(id).edit!.candidates[1]!)
  assert.equal(find(id).status, 'review')
  await busy
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).edit!.candidate!.trackId, 2)
})

test('choose를 연달아 눌러 앞 요청이 늦게 끝나도 마지막 선택이 남는다', async (t) => {
  const OTHER = makeImage(16, 16, 'png') as Uint8Array<ArrayBuffer>
  const cand = (trackId: number, name: string) => ({
    trackId,
    artistName: 'Lee Juck',
    trackName: name,
    collectionName: `앨범${trackId}`,
    trackTimeMillis: 263000,
    artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${name}/100x100bb.jpg`,
  })
  stubAll(t, {
    itunes: () => ({ results: [cand(1, 'firstart'), cand(2, 'slowart'), cand(3, 'lastart')] }),
    artwork: async (url) => {
      if (!url.pathname.includes('slowart')) return new Response(PNG)
      await sleep(150)
      return new Response(OTHER)
    },
  })
  const id = await add(m4a('Twice Band - Twice Song.m4a'))
  const [, second, third] = find(id).edit!.candidates
  const slow = useQueue.getState().choose(id, second!)
  await useQueue.getState().choose(id, third!)
  await slow
  const e = find(id).edit!
  assert.equal(e.candidate!.trackId, 3)
  assert.equal(e.album, '앨범3')
  assert.deepEqual(e.cover, PNG)
})

test('200MB를 넘는 파일은 읽지 않고 실패 처리한다', async () => {
  useQueue.setState({ items: [] })
  let read = false
  const huge = {
    name: 'huge.m4a',
    size: 200 * 2 ** 20 + 1,
    arrayBuffer() {
      read = true
      throw new Error('읽으면 안 된다')
    },
  } as unknown as File
  const { ids, done } = useQueue.getState().addFiles([huge])
  await done
  assert.equal(find(ids[0]!).status, 'failed')
  assert.match(find(ids[0]!).error!, /200MB/)
  assert.equal(read, false)
})
