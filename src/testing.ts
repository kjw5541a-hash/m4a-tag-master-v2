// 테스트 전용 도우미. 앱 코드에서 가져오지 않는다.
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// globalThis.fetch를 handler로 바꾸고, 요청된 URL 목록을 돌려준다.
export function stubFetch(t: TestContext, handler: (url: URL) => Response | Promise<Response>): string[] {
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    const url = new URL(input)
    urls.push(url.href)
    return handler(url)
  })
  return urls
}

// ffmpeg를 돌리고 stdout을 돌려준다. 종료 코드가 0이 아니거나 stderr가 비어 있지 않으면 실패한다.
export function ffmpeg(...args: string[]): Buffer {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 })
  assert.equal(r.status, 0, r.stderr.toString())
  assert.equal(r.stderr.toString(), '', 'ffmpeg가 오류를 냈다')
  return r.stdout
}

// 임시 폴더는 프로세스당 한 번, 처음 필요할 때 만든다.
let dir: string | undefined
let fileNo = 0

/** 3초짜리 사인파 m4a를 만든다. args는 추가 입력·출력 옵션. */
export function makeM4a(...args: string[]): Uint8Array {
  dir ??= mkdtempSync(join(tmpdir(), 'm4a-testing-'))
  const file = join(dir, `in-${fileNo++}.m4a`)
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', ...args, file)
  return new Uint8Array(readFileSync(file))
}

/** 단색 이미지 한 장. */
export function makeImage(width: number, height: number, format: 'mjpeg' | 'png'): Uint8Array {
  const codec = format === 'png' ? ['-f', 'apng', '-plays', '1'] : ['-f', 'mjpeg']
  return new Uint8Array(ffmpeg('-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`, '-frames:v', '1', ...codec, '-'))
}
