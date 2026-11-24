// 스토어의 분석 연결 테스트 (기획서 5.1, 5.5, 9장). 실행기는 가짜로 바꾸고, iTunes·LRCLIB는 0건을 돌려준다.
// 파일은 테스트 전체에서 8개. 곡마다 iTunes 검색 1회라 분당 20회 제한에 걸리지 않는다.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { initialJob, saveAllTargets, setAnalysisRunner, statusLabel, useQueue, type Item } from './store.ts'
import { AnalysisError, decodeFailureReason, MAX_ANALYSIS_SEC, TOO_LONG } from './runAnalysis.ts'
import { parseAnalysis, type MappAnalysisV1 } from './schema.ts'
import { ANALYZER, chordsFromChroma, type BeatChroma } from './analysis.ts'
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

const ran = (...args: Parameters<typeof fake>) => ({ analysis: fake(...args) })

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
    return ran(123.4)
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
    return ran()
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

  // 디코드 뒤에 15분 초과를 알게 되면 실패가 아니라 건너뜀
  setAnalysisRunner(async () => {
    throw new AnalysisError(TOO_LONG)
  })
  await useQueue.getState().analyze(id)
  assert.deepEqual(find(id).analysisJob, { state: 'skipped', message: TOO_LONG })
})

test('분석 중에 remove해도 되살아나지 않고 다음 곡 분석은 끝까지 돈다', async (t) => {
  stubEmpty(t)
  const g = gate()
  let calls = 0
  setAnalysisRunner(async () => {
    if (++calls === 1) await g.promise
    return ran(77)
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
    return ran()
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
  const withAnalysis = { analysis: fake(67.5, { analyzer: ANALYZER }) } as Parameters<typeof initialJob>[0]
  assert.deepEqual(initialJob(withAnalysis, 1), { state: 'done' })
  assert.deepEqual(initialJob(withAnalysis, MAX_ANALYSIS_SEC + 100), { state: 'done' })
})

test('initialJob: 예전 분석기로 넣은 분석은 다시 분석하고, 사람이 고친 것은 그대로 둔다', () => {
  const old = (extra: Partial<MappAnalysisV1>) =>
    ({ analysis: fake(134.9, { analyzer: 'm4a-tag-master@2 essentia.js@0.1.3', ...extra }) }) as Parameters<typeof initialJob>[0]
  assert.deepEqual(initialJob(old({}), 229), { state: 'waiting' })
  assert.deepEqual(initialJob(old({ edited: true }), 229), { state: 'done' })
  // 15분이 넘으면 다시 분석할 수 없으니 들어 있는 값을 그대로 쓴다.
  assert.deepEqual(initialJob(old({}), MAX_ANALYSIS_SEC + 1), { state: 'done' })
})

test('analyze: 컨테이너 길이가 15분을 넘으면 디코드 없이 skipped', async () => {
  let calls = 0
  setAnalysisRunner(async () => {
    calls++
    return ran()
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
    return ran(n)
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
  useQueue.getState().markSaved(id, { name: 'x.m4a', size: 1 })
  await Promise.all([useQueue.getState().analyze(id), useQueue.getState().analyze(id)])
  assert.equal(calls, 3)
  assert.equal(find(id).edit?.analysis?.bpm, 3)
  assert.equal(find(id).analysisJob?.state, 'done')
  assert.equal(find(id).status, 'review')
})

test('statusLabel: 조회가 끝난 곡은 분석 상태와 함께 저장이 필요하다고 보여 준다', () => {
  const label = (status: Item['status'], analysisJob?: Item['analysisJob']) => statusLabel({ status, analysisJob })
  assert.equal(label('review', { state: 'done' }), '분석 완료, 저장 필요')
  assert.equal(label('review', { state: 'failed', message: 'x' }), '분석 실패, 저장 필요')
  assert.equal(label('review', { state: 'skipped', message: 'x' }), '분석 건너뜀, 저장 필요')
  assert.equal(label('review', { state: 'waiting' }), '분석 대기')
  assert.equal(label('review', { state: 'running', progress: 0.426 }), '분석 중 43%')
  assert.equal(label('review'), '저장 필요')
  // 조회 단계·저장·실패는 분석 상태와 관계없이 그대로
  assert.equal(label('searching', { state: 'done' }), '검색 중')
  assert.equal(label('saved', { state: 'done' }), '저장됨')
  assert.equal(label('failed'), '실패')
})

test('decodeFailureReason: 디코드 실패 원인을 짧게 보여 준다', () => {
  assert.equal(decodeFailureReason(new Error('decode timeout')), '60초 넘게 걸림')
  assert.equal(decodeFailureReason(new DOMException('Decoding failed', 'EncodingError')), 'EncodingError: Decoding failed')
  assert.equal(decodeFailureReason(null), 'null')
  assert.equal(decodeFailureReason(new Error('x'.repeat(200))).length, 80)
})

test('saveAllTargets: 저장 필요 곡만 고르고, 검색·분석이 남으면 busy', () => {
  const it = (id: string, status: Item['status'], state?: NonNullable<Item['analysisJob']>['state']) =>
    ({ id, fileName: 'x.m4a', status, analysisJob: state && { state } }) as Item
  const base = [it('a', 'review', 'done'), it('b', 'saved', 'done'), it('c', 'review', 'failed'), it('d', 'failed'), it('e', 'review', 'skipped')]
  const ids = (r: { ready: Item[] }) => r.ready.map((i) => i.id)

  assert.deepEqual(ids(saveAllTargets(base)), ['a', 'c', 'e'])
  assert.equal(saveAllTargets(base).busy, false)
  assert.equal(saveAllTargets([...base, it('f', 'reading')]).busy, true)
  assert.equal(saveAllTargets([...base, it('f', 'searching')]).busy, true)
  const waiting = saveAllTargets([...base, it('f', 'review', 'waiting')])
  assert.equal(waiting.busy, true)
  assert.deepEqual(ids(waiting), ['a', 'c', 'e', 'f'])
  // 저장한 곡을 다시 분석하는 중이면, 끝나고 '저장 필요'로 돌아오므로 기다린다.
  const rerun = saveAllTargets([...base, it('f', 'saved', 'running')])
  assert.equal(rerun.busy, true)
  assert.deepEqual(ids(rerun), ['a', 'c', 'e'])
})

test('setSaveError는 검색 오류(error)를 건드리지 않고, 저장되면 지워진다', () => {
  useQueue.setState({ items: [{ id: 'a', fileName: 'a.m4a', status: 'review', error: '검색 오류' } as Item] })
  const { setSaveError, markSaved } = useQueue.getState()
  setSaveError('a', '저장을 막았어요')
  assert.equal(find('a').saveError, '저장을 막았어요')
  assert.equal(find('a').error, '검색 오류')
  markSaved('a', { name: 'a.m4a', size: 1 })
  assert.equal(find('a').saveError, undefined)
  assert.equal(find('a').status, 'saved')
})

// 0.5초 비트(검출 120 BPM), 앞 4초 C 뒤 4초 G, 2초 지점에 반 비트 F
const CHROMA: BeatChroma = (() => {
  const tri = (notes: number[]) => Array.from({ length: 12 }, (_, p) => (notes.includes(p) ? 1 : 0))
  const bounds = Array.from({ length: 17 }, (_, i) => i * 0.5)
  return { detectedBpm: 120, bounds, chroma: bounds.slice(0, -1).map((t) => (t === 2 ? tri([5, 9, 0]) : t < 4 ? tri([0, 4, 7]) : tri([7, 11, 2]))) }
})()

test('editAnalysis: 분석 크로마가 있으면 BPM을 바꿀 때 코드를 다시 묶는다', async (t) => {
  stubEmpty(t)
  setAnalysisRunner(async () => ({ analysis: fake(240, { chords: chordsFromChroma(CHROMA, 240) }), chroma: CHROMA }))
  const { ids, done } = add(m4a('다시묶기.m4a'))
  const id = ids[0]!
  await done
  assert.ok(find(id).edit?.analysis?.chords.some((c) => c.chord === 'F'))
  useQueue.getState().editAnalysis(id, { bpm: 60 })
  const a = find(id).edit!.analysis!
  assert.equal(a.bpm, 60)
  assert.equal(a.edited, true)
  assert.deepEqual(a.chords, chordsFromChroma(CHROMA, 60))
  // 조성만 바꾸면 코드는 그대로
  useQueue.getState().editAnalysis(id, { key: 'D' })
  assert.deepEqual(find(id).edit!.analysis!.chords, a.chords)
})

test('editAnalysis: 파일에서 읽은 분석(크로마 없음)은 BPM만 바뀐다', () => {
  const chords = [{ start: 0, end: 3, chord: 'C' }]
  useQueue.setState({ items: [{ id: 'f', fileName: 'f.m4a', status: 'review', edit: { analysis: fake(100, { chords }) } } as Item] })
  useQueue.getState().editAnalysis('f', { bpm: 50 })
  assert.equal(find('f').edit!.analysis!.bpm, 50)
  assert.deepEqual(find('f').edit!.analysis!.chords, chords)
})

test('다시 분석하면 크로마와 BPM이 새 분석 값으로 바뀐다', async (t) => {
  stubEmpty(t)
  setAnalysisRunner(async () => ({ analysis: fake(120), chroma: CHROMA }))
  const { ids, done } = add(m4a('재분석.m4a'))
  const id = ids[0]!
  await done
  useQueue.getState().editAnalysis(id, { bpm: 60 })
  const other: BeatChroma = { detectedBpm: 90, bounds: [0, 3], chroma: [Array.from({ length: 12 }, () => 0)] }
  setAnalysisRunner(async () => ({ analysis: fake(90), chroma: other }))
  await useQueue.getState().analyze(id)
  assert.equal(find(id).edit!.analysis!.bpm, 90)
  assert.equal(find(id).chroma, other)
})
