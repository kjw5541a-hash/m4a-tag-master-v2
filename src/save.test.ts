// 저장·공유: 여러 파일을 공유 한 번으로 넘기는지, 오류 문구.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { buildBatch, saveErrorMessage, shareOrDownload } from './save.ts'
import { initialEdit, type Edit, type Source } from './edit.ts'
import { inspect, readTags } from './mp4.ts'
import { parseSource } from './lookup/query.ts'
import { makeM4a } from './testing.ts'

// Node의 전역 navigator에 공유 API를 잠시 붙인다.
function stubShare(t: TestContext, share: (data: ShareData) => Promise<void>) {
  const calls: ShareData[] = []
  const nav = navigator as unknown as Record<string, unknown>
  nav.canShare = () => true
  nav.share = (data: ShareData) => {
    calls.push(data)
    return share(data)
  }
  t.after(() => {
    delete nav.canShare
    delete nav.share
  })
  return calls
}

const file = (name: string) => new File([new Uint8Array([1])], name, { type: 'audio/mp4' })

test('shareOrDownload: 파일 여러 개를 share 한 번으로 넘기고 title·text는 넣지 않는다', async (t) => {
  const calls = stubShare(t, async () => {})
  const a = file('a.m4a')
  const b = file('b.m4a')
  assert.equal(await shareOrDownload([a, b]), 'shared')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { files: [a, b] })
})

test('shareOrDownload: 공유 시트를 닫으면(AbortError) cancelled', async (t) => {
  stubShare(t, async () => {
    throw new DOMException('closed', 'AbortError')
  })
  assert.equal(await shareOrDownload([file('a.m4a')]), 'cancelled')
})

test('saveErrorMessage: NotAllowedError는 다시 누르라고, 그 밖은 이름을 붙인다', () => {
  assert.equal(saveErrorMessage(new DOMException('x', 'NotAllowedError')), '저장 버튼을 한 번 더 눌러 주세요')
  assert.equal(saveErrorMessage(new DOMException('x', 'DataError')), '저장하지 못했어요 (DataError)')
  assert.equal(saveErrorMessage(new Error('x')), '저장하지 못했어요 (알 수 없는 오류)')
})

const song = (id: string, title: string): { id: string; source: Source; edit: Edit } => {
  const bytes = makeM4a()
  const source: Source = { fileName: `${id}.m4a`, bytes, duration: inspect(bytes).duration, tags: readTags(bytes) }
  return { id, source, edit: { ...initialEdit(source, parseSource(source.fileName, source.tags)), artist: '이적', title } }
}

test('buildBatch: 이름이 겹치면 (2)를 붙이고, 편집값이 그대로면 앞서 만든 파일을 다시 쓴다', () => {
  const a = song('a', '하늘을 달리다')
  const b = song('b', '하늘을 달리다')
  const first = buildBatch([a, b])
  assert.deepEqual(first.failed, [])
  assert.deepEqual(first.built.map((x) => x.file.name), ['이적 - 하늘을 달리다.m4a', '이적 - 하늘을 달리다 (2).m4a'])

  // NotAllowedError 뒤 다시 누를 때: 바뀐 게 없으면 다시 만들지 않는다(공유 권한이 끊기지 않게).
  const again = buildBatch([a, b], first.built)
  assert.equal(again.built[0]!.file, first.built[0]!.file)
  assert.equal(again.built[1]!.file, first.built[1]!.file)

  // 편집값이 바뀐 곡만 다시 만든다.
  const b2 = { ...b, edit: { ...b.edit, title: '거짓말거짓말거짓말' } }
  const changed = buildBatch([a, b2], again.built)
  assert.equal(changed.built[0]!.file, first.built[0]!.file)
  assert.equal(changed.built[1]!.file.name, '이적 - 거짓말거짓말거짓말.m4a')
})

test('buildBatch: 검증에 실패한 곡은 빼고 이유를 돌려준다', () => {
  const a = song('a', '하늘을 달리다')
  const broken = { ...song('b', '왼손잡이'), source: { ...a.source, bytes: new Uint8Array(16) } }
  const r = buildBatch([a, broken])
  assert.deepEqual(r.built.map((x) => x.id), ['a'])
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0]!.id, 'b')
  assert.ok(r.failed[0]!.message.length > 0)
})
