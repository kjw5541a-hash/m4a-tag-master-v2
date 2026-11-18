// 네트워크 도우미: 타임아웃·재시도·세션 캐시·호출 제한 (기획서 5.3, 8.4).

// 메시지는 화면에 그대로 보여 준다.
export class LookupError extends Error {}

const TIMEOUT_MS = 8000
const cache = new Map<string, unknown>()

// 404면 null. 네트워크 오류·타임아웃·본문 읽기 실패는 1번 더 시도한 뒤 LookupError.
async function request<T>(url: string, read: (res: Response) => Promise<T>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.status === 404) return null
      if (!res.ok) throw new LookupError(`검색 실패 (${res.status})`)
      return await read(res)
    } catch (e) {
      if (e instanceof LookupError) throw e
      if (attempt > 0) throw new LookupError('검색 실패 (네트워크)')
    }
  }
}

// 2xx 응답만 URL별로 세션 동안 캐시한다. 404·오류는 캐시하지 않는다.
export async function fetchJson(url: string): Promise<unknown | null> {
  if (cache.has(url)) return cache.get(url)
  const body = await request(url, (res) => res.json() as Promise<unknown>)
  if (body !== null) cache.set(url, body)
  return body
}

// 캐시하지 않는다. 바이트는 null을 돌려줄 수 없으므로 404도 오류다.
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const bytes = await request(url, async (res) => new Uint8Array(await res.arrayBuffer()))
  if (bytes === null) throw new LookupError('검색 실패 (404)')
  return bytes
}

// 최근 windowMs 안에 max번 통과했으면, 가장 오래된 통과가 창 밖으로 나갈 때까지 기다린다.
export function limiter(max: number, windowMs: number): () => Promise<void> {
  const passed: number[] = []
  return async () => {
    for (;;) {
      const now = Date.now()
      while (passed.length > 0 && now - passed[0]! >= windowMs) passed.shift()
      if (passed.length < max) {
        passed.push(now)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, passed[0]! + windowMs - now))
    }
  }
}
