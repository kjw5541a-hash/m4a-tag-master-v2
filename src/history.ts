// 이 기기에서 저장한 파일 기록. 원본·결과 파일의 '크기:이름'을 저장 시각과 함께 남겨,
// 같은 곡을 다시 넣었을 때 알아보고 '파일'에 복사본(제목 2.m4a)이 쌓이지 않게 한다.
// 기록을 못 읽거나 못 써도(사생활 모드·용량·Node 테스트) 앱은 그대로 돈다.
// ponytail: 한도 없이 쌓인다. 곡당 100바이트 안팎이라 수천 곡까지 괜찮다. 넘치면 오래된 것부터 지우기.
const KEY = 'saved-files-v1'

export const fileKey = (name: string, size: number) => `${size}:${name}`

function read(): Record<string, string> {
  try {
    // 객체가 아니면(null·배열 등 망가진 값) 빈 기록으로 보고, 다음 저장 때 새로 쓴다.
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** 저장한 적 있으면 그 시각(ISO). */
export const savedAt = (key: string): string | undefined => read()[key]

export function remember(keys: string[], at = new Date().toISOString()): void {
  try {
    const all = read()
    for (const k of keys) all[k] = at
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    // 기록은 없어도 저장 자체는 끝났다.
  }
}
