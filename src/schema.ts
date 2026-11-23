// ----:com.jw.mapp:ANALYSIS 스키마 v1 (기획서 7.2). 웹 MAPP와 MAPP Native가 이 파일을 복사해 쓰므로 다른 모듈을 import하지 않는다.

export type PitchClass = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B'

export const PITCH_CLASSES: PitchClass[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface MappAnalysisV1 {
  version: 1
  analyzer: string // 예: "m4a-tag-master@2 essentia.js@0.1.3"
  analyzedAt: string // ISO 8601
  duration: number // 분석한 오디오 길이(초, 소수 둘째 자리)
  bpm: number // 소수 첫째 자리
  bpmConfidence: number // RhythmExtractor2013 confidence, 0~5.32 (소수 둘째 자리)
  key: PitchClass
  scale: 'major' | 'minor'
  keyStrength: number // 0~1 (소수 둘째 자리)
  edited: boolean // 사람이 bpm·key를 고쳤는지
  topProgressions: { chords: string[]; count: number }[] // 최대 3개
  chords: { start: number; end: number; chord: string }[] // 시간 순, 구간 사이 빈틈 없음 (소수 둘째 자리)
}
// chord 표기: PitchClass + (단조면 "m"). 예: "A#m", "D#". 코드가 없으면 "N".

const isNum = (x: unknown) => typeof x === 'number'
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null

// 파일에서 읽은 값을 검사한다. JSON이 아니거나 version이 1이 아니거나 필수 필드 타입이 틀리면 undefined(오류가 아님).
// 모르는 필드는 버리지 않고 그대로 둔다.
export function parseAnalysis(text: string | undefined): MappAnalysisV1 | undefined {
  if (typeof text !== 'string') return undefined
  let a: unknown
  try {
    a = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObj(a) || a.version !== 1) return undefined
  const ok =
    typeof a.analyzer === 'string' &&
    typeof a.analyzedAt === 'string' &&
    isNum(a.duration) && isNum(a.bpm) && isNum(a.bpmConfidence) && isNum(a.keyStrength) &&
    PITCH_CLASSES.includes(a.key as PitchClass) &&
    (a.scale === 'major' || a.scale === 'minor') &&
    typeof a.edited === 'boolean' &&
    Array.isArray(a.topProgressions) &&
    a.topProgressions.every((p) => isObj(p) && isNum(p.count) && Array.isArray(p.chords) && p.chords.every((c) => typeof c === 'string')) &&
    Array.isArray(a.chords) &&
    a.chords.every((c) => isObj(c) && isNum(c.start) && isNum(c.end) && typeof c.chord === 'string')
  return ok ? (a as unknown as MappAnalysisV1) : undefined
}

// 사람이 bpm·key·scale을 고친 값. bpm은 소수 첫째 자리로 반올림하고 edited를 true로 둔다.
// 반올림한 bpm이 유한하지 않거나 (0, 1000) 밖이면 무시한다(오타·Infinity가 파일에 "null"로 저장되는 것을 막음). 반영할 필드가 없으면 입력을 그대로 돌려준다.
export function editAnalysis(
  a: MappAnalysisV1,
  patch: Partial<Pick<MappAnalysisV1, 'bpm' | 'key' | 'scale'>>,
): MappAnalysisV1 {
  const rounded = patch.bpm === undefined ? NaN : Math.round(patch.bpm * 10) / 10
  const bpm = rounded > 0 && rounded < 1000 ? rounded : undefined // NaN·Infinity는 둘 다 거짓
  if (bpm === undefined && patch.key === undefined && patch.scale === undefined) return a
  return {
    ...a,
    bpm: bpm ?? a.bpm,
    key: patch.key ?? a.key,
    scale: patch.scale ?? a.scale,
    edited: true,
  }
}

// 화면 표기(기획서 F10). 파일에는 # 표기로 저장하고, 보여 줄 때만 조성에 맞춰 ♭으로 바꾼다.
// 관계 장조가 샵 조성(G·D·A·E·B)이면 # 그대로, 그 밖(플랫 조성과 C장조·A단조)은 ♭.
const SHARP_MAJORS = new Set(['G', 'D', 'A', 'E', 'B'])
const FLAT_NAME: Record<string, string> = { 'C#': 'D♭', 'D#': 'E♭', 'F#': 'G♭', 'G#': 'A♭', 'A#': 'B♭' }

function useFlats(key: PitchClass, scale: 'major' | 'minor'): boolean {
  const i = PITCH_CLASSES.indexOf(key)
  const relativeMajor = PITCH_CLASSES[scale === 'minor' ? (i + 3) % 12 : i]
  return !SHARP_MAJORS.has(relativeMajor)
}

/** 'A#m' → 'B♭m'처럼 조성에 맞춘 코드 이름. N과 샵 조성의 코드는 그대로. */
export function spellChord(chord: string, key: PitchClass, scale: 'major' | 'minor'): string {
  if (!useFlats(key, scale)) return chord
  const minor = chord.endsWith('m')
  const root = minor ? chord.slice(0, -1) : chord
  return (FLAT_NAME[root] ?? root) + (minor ? 'm' : '')
}

/** 'G# major' → 'A♭ major'. 조성 이름은 그 조성 자신의 규칙으로 쓴다. */
export const keyLabel = (key: PitchClass, scale: 'major' | 'minor') => `${spellChord(key, key, scale)} ${scale}`
