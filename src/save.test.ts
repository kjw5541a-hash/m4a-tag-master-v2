// 저장·공유: 여러 파일을 공유 한 번으로 넘기는지, 오류 문구.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { saveErrorMessage, shareOrDownload } from './save.ts'

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
