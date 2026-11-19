// 한 곡의 BPM·조성·비트 단위 코드를 구한다. 브라우저 워커와 Node 검증 스크립트가 같이 쓴다.
// essentia.js가 만든 Vector는 JS GC가 회수하지 않으므로, 다 쓰면 직접 delete() 한다.
// 코드 후처리·반복 진행·스키마 변환은 essentia 없이 도는 순수 함수라서 Node 테스트가 직접 부른다.

import type { MappAnalysisV1, PitchClass } from './schema.ts'

export const SAMPLE_RATE = 44100 // RhythmExtractor2013은 44.1kHz를 전제로 한다
const FRAME_SIZE = 4096
const HOP_SIZE = 2048

export interface ChordSegment {
  start: number
  end: number
  chord: string // "A#m", "D#", 코드 없음은 "N"
}

// 비트와 비트 사이 구간 하나(후처리 전). strength는 ChordsDetectionBeats가 준 값.
export interface BeatChord extends ChordSegment {
  strength: number
}

export interface AnalysisResult {
  bpm: number
  bpmConfidence: number // 0~5.32
  ticks: number[] // 비트 위치(초)
  key: string
  scale: string
  keyStrength: number
  chords: ChordSegment[] // finalizeChords를 거친 값: 0초부터 끝까지 빈틈없이, 같은 코드 연속은 병합
  frames: number
  times: { rhythm: number; key: number; hpcp: number; chords: number } // 단계별 ms
}

const FLAT_TO_SHARP: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }
const toSharp = (root: string) => FLAT_TO_SHARP[root] ?? root
const normalizeChord = (c: string) => (c.endsWith('m') ? toSharp(c.slice(0, -1)) + 'm' : toSharp(c))
const round2 = (x: number) => Math.round(x * 100) / 100
const round1 = (x: number) => Math.round(x * 10) / 10

export const ANALYZER = 'm4a-tag-master@2 essentia.js@0.1.3'

// 비트별 코드를 곡 전체의 코드 구간으로 다듬는다.
// 1) 강도가 nThreshold 미만이면 "N"  2) 같은 코드 연속은 합침
// 3) 앞뒤가 같은 코드인 1비트짜리 구간은 앞 코드로 흡수(더 바뀌지 않을 때까지)
// 4) 시간은 소수 둘째 자리. 첫 start와 마지막 end는 입력 그대로, 구간 사이에는 빈틈이 없다.
export function finalizeChords(beats: BeatChord[], nThreshold = 0.3): ChordSegment[] {
  const runs: { start: number; end: number; chord: string; beats: number }[] = []
  for (const b of beats) {
    const chord = b.strength < nThreshold ? 'N' : b.chord
    const last = runs.at(-1)
    if (last && last.chord === chord) {
      last.end = b.end
      last.beats++
    } else {
      runs.push({ start: b.start, end: b.end, chord, beats: 1 })
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (let i = 1; i + 1 < runs.length; i++) {
      // 이웃한 구간은 항상 코드가 다르므로, 앞뒤가 같기만 하면 가운데는 앞뒤와 다르다.
      if (runs[i].beats === 1 && runs[i - 1].chord === runs[i + 1].chord) {
        runs[i - 1].end = runs[i + 1].end
        runs[i - 1].beats += 2
        runs.splice(i, 2)
        changed = true
        i--
      }
    }
  }
  return runs.map((r, i) => ({
    start: i === 0 ? r.start : round2(r.start),
    end: i === runs.length - 1 ? r.end : round2(runs[i + 1].start),
    chord: r.chord,
  }))
}

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
  const pcp = new essentia.module.VectorVectorFloat()
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
    pcp.push_back(hpcp.hpcp)
    for (const v of [frame, windowed.frame, spectrum.spectrum, peaks.frequencies, peaks.magnitudes, hpcp.hpcp]) {
      v.delete()
    }
    if (i % 256 === 0) onProgress('hpcp', i / frameCount)
  }
  lap('hpcp')

  // 비트와 비트 사이 구간마다 코드 하나
  onProgress('chords', 0)
  const detected = essentia.ChordsDetectionBeats(pcp, rhythm.ticks, 'interbeat_median', HOP_SIZE, SAMPLE_RATE)
  const names: string[] = []
  for (let i = 0; i < detected.chords.size(); i++) names.push(detected.chords.get(i))
  const strengths = Array.from(essentia.vectorToArray(detected.strength) as Float32Array)
  for (const v of [detected.chords, detected.strength, pcp, rhythm.ticks]) v.delete()

  // 경계: 0, 비트들, 곡 끝. 첫 비트 전과 코드가 없는 구간은 "N".
  const bounds = [0, ...ticks, duration].map(round2)
  const beats: BeatChord[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [start, end] = [bounds[i], bounds[i + 1]]
    if (end <= start) continue
    const beat = i - 1 // bounds[i] = ticks[i-1]
    beats.push(
      beat >= 0 && beat < names.length
        ? { start, end, chord: normalizeChord(names[beat]), strength: strengths[beat] }
        : { start, end, chord: 'N', strength: 0 },
    )
  }
  const chords = finalizeChords(beats)
  lap('chords')

  return {
    bpm: rhythm.bpm,
    bpmConfidence: rhythm.confidence,
    ticks,
    key: toSharp(key.key),
    scale: key.scale,
    keyStrength: key.strength,
    chords,
    frames: frameCount,
    times,
  }
}
