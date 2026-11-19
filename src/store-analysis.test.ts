// 스토어의 분석 연결 테스트 (기획서 5.1, 5.5, 9장). 실행기는 가짜로 바꾸고, iTunes·LRCLIB는 0건을 돌려준다.
// 파일은 테스트 전체에서 8개. 곡마다 iTunes 검색 1회라 분당 20회 제한에 걸리지 않는다.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { initialJob, setAnalysisRunner, useQueue, type Item } from './store.ts'
import { AnalysisError, MAX_ANALYSIS_SEC } from './runAnalysis.ts'
import { parseAnalysis, type MappAnalysisV1 } from './schema.ts'
import { readTags, writeTags } from './mp4.ts'
import { buildOutput } from './save.ts'
import { makeM4a, stubFetch } from './testing.ts'

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

// 검색은 모두 0건
const stubEmpty = (t: TestContext) =>
  stubFetch(t, (url) => {
    if (url.hostname === 'itunes.apple.com') return json({ resultCount: 0, results: [] })
    if (url.pathname === '/api/get') return new Response('', { status: 404 })
    return json([])
  })

const fake = (bpm = 100, extra: Partial<MappAnalysisV1> = {}): MappAnalysisV1 => ({
  version: 1,
  analyzer: 'fake',
  analyzedAt: '2026-01-01T00:00:00.000Z',
  duration: 3,
  bpm,
  bpmConfidence: 1,
  key: 'C',
  scale: 'major',
  keyStrength: 0.5,
  edited: false,
  topProgressions: [],
  chords: [],
  ...extra,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await sleep(5)
  assert.ok(cond(), '조건이 시간 안에 참이 되지 않았다')
}

const m4a = (name: string, bytes = makeM4a()) => new File([bytes as Uint8Array<ArrayBuffer>], name)
const find = (id: string) => useQueue.getState().items.find((i) => i.id === id)!
const add = (...files: File[]) => {
  useQueue.setState({ items: [] })
  return useQueue.getState().addFiles(files)
}
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { open, promise }
}

test('파일을 추가하면 분석이 돌고(running·진행률) 결과가 edit.analysis에 들어간다', async (t) => {
  stubEmpty(t)
  const g = gate()
  setAnalysisRunner(async (_bytes, onProgress) => {
    onProgress(0.5)
    await g.promise
    return fake(123.4)
  })
  const { ids, done } = add(m4a('분석곡1.m4a'))
  const id = ids[0]!
  await until(() => find(id).analysisJob?.progress === 0.5)
  assert.equal(find(id).analysisJob?.state, 'running')
  g.open()
  await done
  assert.equal(find(id).analysisJob?.state, 'done')
  assert.equal(find(id).edit?.analysis?.bpm, 123.4)
  assert.equal(find(id).status, 'review')
})

test('두 곡을 추가해도 분석은 한 번에 하나씩 돈다', async (t) => {
  stubEmpty(t)
  let active = 0
  let max = 0
  let calls = 0
  setAnalysisRunner(async () => {
    calls++
    max = Math.max(max, ++active)
    await sleep(30)
    active--
    return fake()
  })
  const { ids, done } = add(m4a('동시곡1.m4a'), m4a('동시곡2.m4a'))
  await done
  assert.equal(calls, 2)
  assert.equal(max, 1)
  for (const id of ids) assert.equal(find(id).analysisJob?.state, 'done')
})

test('실행기가 AnalysisError로 실패하면 failed와 그 문구, status는 review. 그 밖의 오류도 failed', async (t) => {
  stubEmpty(t)
  setAnalysisRunner(async () => {
    throw new AnalysisError('분석 중 메모리가 부족했어요')
  })
  const { ids, done } = add(m4a('실패곡1.m4a'))
  const id = ids[0]!
  await done
  assert.deepEqual(find(id).analysisJob, { state: 'failed', message: '분석 중 메모리가 부족했어요' })
  assert.equal(find(id).status, 'review')
  assert.equal(find(id).edit?.analysis, undefined)

  // 워커를 못 만드는 것 같은 AnalysisError가 아닌 오류
  setAnalysisRunner(async () => {
    throw new TypeError('x')
  })
  await useQueue.getState().analyze(id)
  assert.deepEqual(find(id).analysisJob, { state: 'failed', message: '분석 중 메모리가 부족했어요' })
})

test('분석 중에 remove해도 되살아나지 않고 다음 곡 분석은 끝까지 돈다', async (t) => {
  stubEmpty(t)
  const g = gate()
  let calls = 0
  setAnalysisRunner(async () => {
    if (++calls === 1) await g.promise
    return fake(77)
  })
  const { ids, done } = add(m4a('삭제곡1.m4a'), m4a('삭제곡2.m4a'))
  await until(() => find(ids[0]!).analysisJob?.state === 'running')
  useQueue.getState().remove(ids[0]!)
  g.open()
  await done
  assert.equal(useQueue.getState().items.length, 1)
  assert.equal(useQueue.getState().items[0]!.id, ids[1])
  assert.equal(find(ids[1]!).analysisJob?.state, 'done')
  assert.equal(find(ids[1]!).edit?.analysis?.bpm, 77)
})

test('파일에 v1 ANALYSIS가 이미 있으면 분석하지 않고 그 값을 쓰며, 저장 파일에도 그대로 들어간다', async (t) => {
  stubEmpty(t)
  const saved = fake(61, { edited: true })
  let calls = 0
  setAnalysisRunner(async () => {
    calls++
    return fake()
  })
  const { ids, done } = add(m4a('기존곡1.m4a', writeTags(makeM4a(), { analysis: JSON.stringify(saved) })))
  const id = ids[0]!
  await done
  assert.equal(calls, 0)
  assert.equal(find(id).analysisJob?.state, 'done')
  assert.equal(find(id).edit?.analysis?.bpm, 61)
  assert.equal(find(id).edit?.analysis?.edited, true)
  const item = find(id)
  const out = buildOutput(item.source!, item.edit!)
  assert.deepEqual(parseAnalysis(readTags(new Uint8Array(await out.arrayBuffer())).analysis), saved)
})

test('initialJob: 분석 있음 → done, 15분 초과 → skipped, 그 밖 → waiting', () => {
  const edit = { analysis: undefined } as Parameters<typeof initialJob>[0]
  assert.deepEqual(initialJob(edit, MAX_ANALYSIS_SEC + 1), {
    state: 'skipped',
    message: '분석은 15분 이하 곡만 할 수 있어요. 태그는 저장할 수 있어요',
  })
  assert.deepEqual(initialJob(edit, 300), { state: 'waiting' })
  assert.deepEqual(initialJob(edit, MAX_ANALYSIS_SEC), { state: 'waiting' })
  const withAnalysis = { analysis: fake() } as Parameters<typeof initialJob>[0]
  assert.deepEqual(initialJob(withAnalysis, 1), { state: 'done' })
  assert.deepEqual(initialJob(withAnalysis, MAX_ANALYSIS_SEC + 100), { state: 'done' })
})

test('analyze: 컨테이너 길이가 15분을 넘으면 디코드 없이 skipped', async () => {
  let calls = 0
  setAnalysisRunner(async () => {
    calls++
    return fake()
  })
  const long: Item = {
    id: 'long',
    fileName: 'long.m4a',
    status: 'review',
    source: { fileName: 'long.m4a', bytes: new Uint8Array(), duration: MAX_ANALYSIS_SEC + 1, tags: {} },
  }
  useQueue.setState({ items: [long] })
  await useQueue.getState().analyze('long')
  assert.equal(calls, 0)
  assert.deepEqual(find('long').analysisJob, {
    state: 'skipped',
    message: '분석은 15분 이하 곡만 할 수 있어요. 태그는 저장할 수 있어요',
  })
})

test('analyze를 연달아 부르면 마지막 결과만 남는다. 저장됨이었다면 확인 필요로 돌아간다', async (t) => {
  stubEmpty(t)
  const g = gate()
  let calls = 0
  setAnalysisRunner(async () => {
    const n = ++calls
    if (n === 1) await g.promise
    return fake(n)
  })
  const { ids, done } = add(m4a('연달아곡1.m4a'))
  const id = ids[0]!
  // 첫 분석이 도는 중에 다시 부르면 첫 결과는 버려진다
  await until(() => find(id).analysisJob?.state === 'running')
  const second = useQueue.getState().analyze(id)
  g.open()
  await Promise.all([done, second])
  assert.equal(calls, 2)
  assert.equal(find(id).edit?.analysis?.bpm, 2)

  // 붙어서 두 번 부르면 앞의 것은 아예 돌지 않는다
  useQueue.getState().markSaved(id, 'x.m4a')
  await Promise.all([useQueue.getState().analyze(id), useQueue.getState().analyze(id)])
  assert.equal(calls, 3)
  assert.equal(find(id).edit?.analysis?.bpm, 3)
  assert.equal(find(id).analysisJob?.state, 'done')
  assert.equal(find(id).status, 'review')
})
