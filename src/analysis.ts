// 한 곡의 BPM·조성·비트 단위 코드를 구한다. 브라우저 워커와 Node 검증 스크립트가 같이 쓴다.
// essentia.js가 만든 Vector는 JS GC가 회수하지 않으므로, 다 쓰면 직접 delete() 한다.
// 코드 후처리·반복 진행·스키마 변환은 essentia 없이 도는 순수 함수라서 Node 테스트가 직접 부른다.

import { PITCH_CLASSES, type MappAnalysisV1, type PitchClass } from './schema.ts'

export const SAMPLE_RATE = 44100 // RhythmExtractor2013은 44.1kHz를 전제로 한다
const FRAME_SIZE = 4096
const HOP_SIZE = 2048

export interface ChordSegment {
  start: number
  end: number
  chord: string // "A#m", "D#", 코드 없음은 "N"
}

export interface AnalysisResult {
  bpm: number // musicalBpm을 거친 값(발라드 두 배 보정)
  bpmConfidence: number // 0~5.32
  ticks: number[] // 비트 위치(초)
  key: string
  scale: string
  keyStrength: number
  chords: ChordSegment[] // chordsFromChroma 결과: 0초부터 끝까지 빈틈없이, 같은 코드 연속은 병합
  beatChroma: BeatChroma // BPM을 고치면 다시 묶는 데 쓴다
  frames: number
  times: { rhythm: number; key: number; hpcp: number; chords: number } // 단계별 ms
}

const FLAT_TO_SHARP: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }
const toSharp = (root: string) => FLAT_TO_SHARP[root] ?? root
const round2 = (x: number) => Math.round(x * 100) / 100
const round1 = (x: number) => Math.round(x * 10) / 10

export const ANALYZER = 'm4a-tag-master@3 essentia.js@0.1.3'

// 기획서 7.3: N을 빼고 연속 중복을 합친 코드 순서에서 연속 4개 묶음을 모두 모아, 회전이 같은 것은 같은 루프로 센다.
// 2회 이상 나온 루프를 횟수 내림차순(같으면 먼저 나온 순)으로 최대 3개. 보여 줄 chords는 곡에서 처음 나온 회전.
export function topProgressions(chords: { chord: string }[]): { chords: string[]; count: number }[] {
  const seq = chords.map((c) => c.chord).filter((c) => c !== 'N').filter((c, i, a) => c !== a[i - 1])
  const loops = new Map<string, { chords: string[]; count: number }>() // Map은 넣은 순서를 지킨다
  for (let i = 0; i + 4 <= seq.length; i++) {
    const win = seq.slice(i, i + 4)
    const key = [0, 1, 2, 3].map((r) => win.slice(r).concat(win.slice(0, r)).join(' ')).sort()[0]
    const loop = loops.get(key)
    if (loop) loop.count++
    else loops.set(key, { chords: win, count: 1 })
  }
  return [...loops.values()].filter((l) => l.count >= 2).sort((a, b) => b.count - a.count).slice(0, 3)
}

/**
 * 비트 사이 구간마다의 평균 크로마. 사용자가 BPM을 고치면 이것으로 코드를 다시 묶는다(파일에는 넣지 않는다).
 * bounds = [0, ...비트(초), 곡 길이], chroma[i]는 [bounds[i], bounds[i+1]) 구간의 12음(0=C) 평균.
 */
export interface BeatChroma {
  detectedBpm: number // essentia가 잡은 BPM. 비트 간격이 이 값을 따른다
  bounds: number[]
  chroma: number[][]
}

// 발라드는 8분음표를 박으로 잡아 두 배로 나오는 일이 많다(180도 134.9 → 68, 산책 132.2).
// ponytail: 120 이상을 일괄 반으로 하므로 실제로 빠른 곡(120~200)은 반으로 나온다. 사용자가 ×2로 고치면 코드도 다시 묶인다.
const HALF_FROM_BPM = 120
export const musicalBpm = (detected: number) => (detected >= HALF_FROM_BPM ? detected / 2 : detected)

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const TRIADS = PITCH_CLASSES.flatMap((name, root) => [
  { name, root, minor: false, notes: [root, (root + 4) % 12, (root + 7) % 12] },
  { name: `${name}m`, root, minor: true, notes: [root, (root + 3) % 12, (root + 7) % 12] },
])
const N_MIN = 0.5 // 가장 잘 맞는 3화음과의 코사인이 이보다 낮으면 N
const KEY_BONUS = 1.1 // 주변 장음계의 3화음(I ii iii IV V vi)에 주는 가산점
const KEY_WINDOW = 8 // 주변 음계를 볼 때 앞뒤 묶음 수(반 마디 기준 약 ±15초)

const norm = (v: number[]) => Math.hypot(...v)
const cosine = (v: number[], notes: number[], n: number) => (n ? (v[notes[0]] + v[notes[1]] + v[notes[2]]) / (n * Math.sqrt(3)) : 0)

// 장음계 r의 3화음인지: 장 I·IV·V(r, r+5, r+7), 단 ii·iii·vi(r+2, r+4, r+9)
const diatonic = (t: (typeof TRIADS)[number], r: number) =>
  (t.minor ? [2, 4, 9] : [0, 5, 7]).some((iv) => (r + iv) % 12 === t.root)

/** BPM의 2박(반 마디)마다 코드 하나. 묶음 시작점은 코드가 가장 또렷해지는 비트에 맞추고, 같은 코드 연속은 합친다. */
export function chordsFromChroma(c: BeatChroma, bpm: number): ChordSegment[] {
  const n = c.chroma.length
  const k = Math.max(1, Math.round((2 * c.detectedBpm) / bpm)) // 반 마디에 든 비트 수
  type Group = { start: number; end: number; chroma: number[]; best: number }
  let chosen: Group[] = []
  let chosenScore = -1
  // 첫 박을 모르므로 시작점을 모두 해 보고, 가장 잘 맞는 3화음 점수의 (길이 가중) 평균이 가장 큰 쪽을 쓴다.
  // 합으로 비교하면 묶음 수가 많은 시작점이 이긴다.
  for (let o = 0; o < Math.max(1, Math.min(k, n - 1)); o++) {
    const starts = [0]
    for (let i = 1 + o; i < n; i += k) starts.push(i)
    const groups = starts.map((from, j): Group => {
      const to = starts[j + 1] ?? n
      const chroma = Array.from({ length: 12 }, () => 0)
      for (let i = from; i < to; i++) {
        const w = Math.max(0, c.bounds[i + 1] - c.bounds[i])
        for (let p = 0; p < 12; p++) chroma[p] += c.chroma[i][p] * w
      }
      const len = norm(chroma)
      return { start: c.bounds[from], end: c.bounds[to], chroma, best: Math.max(...TRIADS.map((t) => cosine(chroma, t.notes, len))) }
    })
    const score = groups.reduce((sum, g) => sum + g.best * (g.end - g.start), 0)
    if (score > chosenScore) [chosen, chosenScore] = [groups, score]
  }

  const segs: ChordSegment[] = []
  chosen.forEach((g, i) => {
    if (g.end <= g.start) return
    // 주변 구간에 가장 잘 맞는 장음계(전조가 있으면 구간마다 달라진다)
    const around = Array.from({ length: 12 }, () => 0)
    for (const h of chosen.slice(Math.max(0, i - KEY_WINDOW), i + KEY_WINDOW + 1)) for (let p = 0; p < 12; p++) around[p] += h.chroma[p]
    const fit = (r: number) => MAJOR_SCALE.reduce((sum, iv) => sum + around[(r + iv) % 12], 0)
    const scale = [...Array(12).keys()].reduce((a, b) => (fit(b) > fit(a) ? b : a))
    const len = norm(g.chroma)
    let chord = 'N'
    let best = N_MIN
    for (const t of TRIADS) {
      const score = cosine(g.chroma, t.notes, len) * (diatonic(t, scale) ? KEY_BONUS : 1)
      if (score >= best) [chord, best] = [t.name, score + 1e-12] // 같으면 앞의 것(1e-12로 뒤 동점을 막음)
    }
    const last = segs.at(-1)
    if (last && last.chord === chord) last.end = g.end
    else segs.push({ start: g.start, end: g.end, chord })
  })
  return segs
}

/** 사람이 고친 BPM(a.bpm)으로 코드를 다시 묶는다. chords·topProgressions 말고는 그대로 둔다. */
export function regroup(a: MappAnalysisV1, c: BeatChroma): MappAnalysisV1 {
  const chords = chordsFromChroma(c, a.bpm).map((s) => ({ start: round2(s.start), end: round2(s.end), chord: s.chord }))
  return { ...a, chords, topProgressions: topProgressions(chords) }
}

// 분석 결과를 파일에 넣을 v1 JSON 객체로 바꾼다(반올림 포함).
export function toAnalysis(r: AnalysisResult, durationSec: number, analyzedAt: string): MappAnalysisV1 {
  return {
    version: 1,
    analyzer: ANALYZER,
    analyzedAt,
    duration: round2(durationSec),
    bpm: round1(r.bpm),
    bpmConfidence: round2(r.bpmConfidence),
    key: r.key as PitchClass,
    scale: r.scale as 'major' | 'minor',
    keyStrength: round2(r.keyStrength),
    edited: false,
    topProgressions: topProgressions(r.chords),
    chords: r.chords.map((c) => ({ start: round2(c.start), end: round2(c.end), chord: c.chord })),
  }
}

// multifeature: 비트 정확도·confidence 있음, 5분 곡 기준 WASM 힙 +166MB·6초(Mac).
// degara: confidence 없음(항상 0), +27MB·1초. M0에서 아이폰 실측 후 하나로 정한다.
export type RhythmMethod = 'multifeature' | 'degara'

export function analyze(
  essentia: any,
  signal: Float32Array,
  method: RhythmMethod = 'multifeature',
  onProgress: (stage: string, ratio: number) => void = () => {},
): AnalysisResult {
  const duration = signal.length / SAMPLE_RATE
  const times = { rhythm: 0, key: 0, hpcp: 0, chords: 0 }
  let t = performance.now()
  const lap = (stage: keyof typeof times) => {
    const now = performance.now()
    times[stage] = Math.round(now - t)
    t = now
  }

  const signalVec = essentia.arrayToVector(signal)

  onProgress('rhythm', 0)
  const rhythm = essentia.RhythmExtractor2013(signalVec, 208, method, 40)
  const ticks = Array.from(essentia.vectorToArray(rhythm.ticks) as Float32Array)
  rhythm.estimates.delete()
  rhythm.bpmIntervals.delete()
  lap('rhythm')

  onProgress('key', 0)
  const key = essentia.KeyExtractor(signalVec)
  signalVec.delete()
  lap('key')

  // 프레임마다 HPCP(12음 크로마)를 구한다. 파라미터는 M3 평가에서 조정한다.
  // essentia.FrameGenerator는 전체 프레임을 한 번에 만들어 5분 곡에 약 108MB를 쓰므로,
  // 프레임 i의 중심이 i*HOP에 오도록(Essentia 기본 규칙) 한 개씩 잘라 넘긴다.
  const frameCount = Math.ceil(signal.length / HOP_SIZE)
  const frameBuf = new Float32Array(FRAME_SIZE)
  const frames: Float32Array[] = [] // 프레임마다 12음 크로마, 0=C
  for (let i = 0; i < frameCount; i++) {
    const start = i * HOP_SIZE - FRAME_SIZE / 2
    const from = Math.max(0, start)
    frameBuf.fill(0)
    frameBuf.set(signal.subarray(from, Math.min(signal.length, start + FRAME_SIZE)), from - start)
    const frame = essentia.arrayToVector(frameBuf)
    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, 'blackmanharris62')
    const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE)
    const peaks = essentia.SpectralPeaks(spectrum.spectrum, 0.00001, 3500, 60, 20, 'magnitude', SAMPLE_RATE)
    const hpcp = essentia.HPCP(
      peaks.frequencies, peaks.magnitudes,
      true, 500, 8, 3500, false, 20, true, 'unitMax', 440, SAMPLE_RATE, 12, 'cosine', 1,
    )
    // essentia HPCP는 0번이 A(440Hz 기준)라서 0번이 C가 되게 돌린다.
    const a = essentia.vectorToArray(hpcp.hpcp) as Float32Array
    const c = new Float32Array(12)
    for (let h = 0; h < 12; h++) c[(h + 9) % 12] = a[h]
    frames.push(c)
    for (const v of [frame, windowed.frame, spectrum.spectrum, peaks.frequencies, peaks.magnitudes, hpcp.hpcp]) {
      v.delete()
    }
    if (i % 256 === 0) onProgress('hpcp', i / frameCount)
  }
  lap('hpcp')

  // 비트 사이 구간마다 프레임(중심 i·HOP) 평균 크로마를 내고, BPM의 반 마디마다 코드를 고른다.
  onProgress('chords', 0)
  const bounds = [0, ...ticks.filter((t) => t > 0 && t < duration), duration].filter((t, i, a) => i === 0 || t > a[i - 1])
  const chroma = bounds.slice(0, -1).map(() => Array.from({ length: 12 }, () => 0))
  const counts = chroma.map(() => 0)
  for (let i = 0, b = 0; i < frames.length; i++) {
    const t = (i * HOP_SIZE) / SAMPLE_RATE
    while (b + 1 < chroma.length && t >= bounds[b + 1]) b++
    for (let p = 0; p < 12; p++) chroma[b][p] += frames[i][p]
    counts[b]++
  }
  chroma.forEach((v, b) => counts[b] && v.forEach((x, p) => (v[p] = x / counts[b])))
  rhythm.ticks.delete()
  const beatChroma: BeatChroma = { detectedBpm: rhythm.bpm, bounds, chroma }
  const bpm = musicalBpm(rhythm.bpm)
  const chords = chordsFromChroma(beatChroma, bpm)
  lap('chords')

  return {
    bpm,
    bpmConfidence: rhythm.confidence,
    ticks,
    key: toSharp(key.key),
    scale: key.scale,
    keyStrength: key.strength,
    chords,
    beatChroma,
    frames: frameCount,
    times,
  }
}
