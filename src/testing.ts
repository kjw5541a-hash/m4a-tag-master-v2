// 테스트 전용 도우미. 앱 코드에서 가져오지 않는다.
import type { TestContext } from 'node:test'

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
