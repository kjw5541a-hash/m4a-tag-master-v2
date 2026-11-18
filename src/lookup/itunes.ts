// iTunes Search API 검색 (기획서 5.3). CORS * 이므로 프록시 없이 직접 부른다.
import { fetchJson, limiter } from './http.ts'

export interface Candidate {
  trackId: number
  title: string
  artist: string
  album: string
  durationSec: number
  // 1000px 주소. 없으면 ''.
  artworkUrl: string
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// 응답 순서를 유지하고 trackId로 중복을 없앤다. trackId·trackName 없는 결과는 버린다.
export function parseItunes(json: unknown): Candidate[] {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  const seen = new Set<number>()
  const out: Candidate[] = []
  for (const r of results as Record<string, unknown>[]) {
    const { trackId, trackName } = r
    if (typeof trackId !== 'number' || typeof trackName !== 'string' || seen.has(trackId)) continue
    seen.add(trackId)
    out.push({
      trackId,
      title: trackName,
      artist: str(r.artistName),
      album: str(r.collectionName),
      durationSec: typeof r.trackTimeMillis === 'number' ? r.trackTimeMillis / 1000 : 0,
      artworkUrl: str(r.artworkUrl100).replace(/\d+x\d+bb/, '1000x1000bb'),
    })
  }
  return out
}

// 분당 20회 (앱 전체 공유).
const wait = limiter(20, 60_000)

// 검색어를 순서대로 시도하고, 결과가 나오면 거기서 멈춘다.
export async function searchItunes(queries: string[]): Promise<{ query: string; candidates: Candidate[] }> {
  for (const query of queries) {
    await wait()
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10&country=US`
    const candidates = parseItunes(await fetchJson(url))
    if (candidates.length > 0) return { query, candidates }
  }
  return { query: queries[0] ?? '', candidates: [] }
}
