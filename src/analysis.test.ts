// 분석 데이터 테스트: 코드 후처리, 반복 진행(기획서 7.3), 스키마 v1(7.2). essentia 없이 순수 함수만.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANALYZER, finalizeChords, toAnalysis, topProgressions, type AnalysisResult, type BeatChord } from './analysis.ts'
import { editAnalysis, parseAnalysis } from './schema.ts'

// 1초짜리 비트를 이어 붙인다: [코드, 강도]
const beatsOf = (xs: [string, number][]): BeatChord[] =>
  xs.map(([chord, strength], i) => ({ start: i, end: i + 1, chord, strength }))
const progression = (names: string) => names.split(' ').map((chord) => ({ chord }))

const fake = (chords: AnalysisResult['chords']): AnalysisResult => ({
  bpm: 117.66, bpmConfidence: 2.178, ticks: [], key: 'F', scale: 'minor', keyStrength: 0.9412,
  chords, frames: 0, times: { rhythm: 0, key: 0, hpcp: 0, chords: 0 },
})

test('finalizeChords: 약한 구간은 N, 같은 코드는 합치고, 앞뒤가 같은 1비트는 흡수한다', () => {
  const beats = beatsOf([['N', 0], ['C', 0.9], ['C', 0.8], ['G', 0.9], ['C', 0.9], ['C', 0.2], ['Am', 0.7]])
  assert.deepEqual(finalizeChords(beats), [
    { start: 0, end: 1, chord: 'N' },
    { start: 1, end: 5, chord: 'C' },
    { start: 5, end: 6, chord: 'N' },
    { start: 6, end: 7, chord: 'Am' },
  ])
})

test('finalizeChords: 시간은 소수 둘째 자리, 구간 사이에 빈틈이 없다', () => {
  const beats: BeatChord[] = [
    { start: 0, end: 1.234567, chord: 'C', strength: 0.9 },
    { start: 1.234567, end: 2.345678, chord: 'G', strength: 0.9 },
    { start: 2.345678, end: 3.456789, chord: 'Am', strength: 0.9 },
  ]
  const chords = finalizeChords(beats)
  assert.equal(chords[0].end, 1.23)
  assert.equal(chords[1].end, 2.35)
  assert.equal(chords[0].start, 0)
  assert.equal(chords.at(-1)!.end, 3.456789) // 마지막 end는 입력 그대로
  for (let i = 1; i < chords.length; i++) assert.equal(chords[i].start, chords[i - 1].end)
})

test('topProgressions: N을 빼고 겹쳐 센 묶음이 모두 같은 루프면 하나로 센다', () => {
  assert.deepEqual(topProgressions(progression('A B C D A B C D N A B')), [{ chords: ['A', 'B', 'C', 'D'], count: 7 }])
})

test('topProgressions: 1회뿐이거나 반복이 없으면 빠지고, 횟수가 같으면 먼저 나온 루프가 앞', () => {
  assert.deepEqual(topProgressions(progression('A B C D E F G A')), [])
  assert.deepEqual(topProgressions([]), [])
  // 두 루프 모두 정확히 2회(회전 포함). 곡에서 먼저 나온 쪽이 앞.
  assert.deepEqual(topProgressions(progression('A B C D A E F G H E')), [
    { chords: ['A', 'B', 'C', 'D'], count: 2 },
    { chords: ['E', 'F', 'G', 'H'], count: 2 },
  ])
  assert.deepEqual(topProgressions(progression('E F G H E A B C D A')).map((p) => p.chords[0]), ['E', 'A'])
  // 최대 3개
  assert.equal(topProgressions(progression('A B C D A E F G H E I J K L I M N O P M')).length, 3)
})

test('topProgressions: 연속 중복은 합치고, 보여 주는 회전은 곡에서 처음 나온 것', () => {
  assert.deepEqual(topProgressions(progression('A A B B C C D D A B C D')), [{ chords: ['A', 'B', 'C', 'D'], count: 5 }])
  assert.deepEqual(topProgressions(progression('B C D A B C D A')), [{ chords: ['B', 'C', 'D', 'A'], count: 5 }])
})

test('toAnalysis: 반올림, 상수, edited false', () => {
  const chords = [
    { start: 0, end: 1, chord: 'N' },
    { start: 1, end: 2.5, chord: 'Fm' },
    { start: 2.5, end: 297.17, chord: 'C#' },
  ]
  const a = toAnalysis(fake(chords), 297.1739, '2026-11-19T00:00:00.000Z')
  assert.equal(a.version, 1)
  assert.equal(a.analyzer, ANALYZER)
  assert.equal(a.analyzer, 'm4a-tag-master@2 essentia.js@0.1.3')
  assert.equal(a.analyzedAt, '2026-11-19T00:00:00.000Z')
  assert.equal(a.duration, 297.17)
  assert.equal(a.bpm, 117.7)
  assert.equal(a.bpmConfidence, 2.18)
  assert.equal(a.keyStrength, 0.94)
  assert.equal(a.key, 'F')
  assert.equal(a.scale, 'minor')
  assert.equal(a.edited, false)
  assert.deepEqual(a.chords, chords)
  assert.deepEqual(a.topProgressions, [])
})

test('parseAnalysis: 직렬화한 값을 그대로 읽고, 틀린 것은 undefined, 모르는 필드는 남긴다', () => {
  const a = toAnalysis(fake([{ start: 0, end: 1, chord: 'N' }]), 1, '2026-11-19T00:00:00.000Z')
  const text = JSON.stringify(a)
  assert.deepEqual(parseAnalysis(text), a)
  assert.equal(parseAnalysis('{"version":2}'), undefined)
  assert.equal(parseAnalysis('not json'), undefined)
  assert.equal(parseAnalysis(undefined), undefined)
  assert.equal(parseAnalysis('null'), undefined)
  assert.equal(parseAnalysis(JSON.stringify({ ...a, key: 'Db' })), undefined)
  assert.equal(parseAnalysis(JSON.stringify({ ...a, bpm: '120' })), undefined)
  assert.equal(parseAnalysis(JSON.stringify({ ...a, chords: [{ start: 0 }] })), undefined)
  const extra = parseAnalysis(JSON.stringify({ ...a, extra: 1 })) as unknown as Record<string, unknown>
  assert.equal(extra.extra, 1)
})

test('editAnalysis: bpm은 소수 첫째 자리로 반올림하고 edited true, 나머지는 그대로', () => {
  const a = toAnalysis(fake([{ start: 0, end: 1, chord: 'N' }]), 1, '2026-11-19T00:00:00.000Z')
  const e = editAnalysis(a, { bpm: 61.04 })
  assert.equal(e.bpm, 61)
  assert.equal(e.edited, true)
  assert.deepEqual({ ...e, bpm: a.bpm, edited: false }, a)
  const k = editAnalysis(a, { key: 'A#', scale: 'major' })
  assert.equal(k.key, 'A#')
  assert.equal(k.scale, 'major')
  assert.equal(k.bpm, a.bpm)
  assert.equal(a.edited, false) // 원본은 건드리지 않는다
})

test('editAnalysis: 범위 밖 bpm(0 이하, 1000 이상, 무한대)은 무시하고, 그것뿐이면 입력을 그대로 돌려준다', () => {
  const a = toAnalysis(fake([{ start: 0, end: 1, chord: 'N' }]), 1, '2026-11-19T00:00:00.000Z')
  assert.equal(editAnalysis(a, { bpm: 1200 }), a)
  assert.equal(editAnalysis(a, { bpm: Infinity }), a)
  assert.equal(editAnalysis(a, { bpm: 0 }), a)
  const mixed = editAnalysis(a, { bpm: 1200, key: 'A#' }) // 나머지 필드는 적용, bpm은 이전 값
  assert.equal(mixed.key, 'A#')
  assert.equal(mixed.bpm, a.bpm)
  assert.equal(mixed.edited, true)
  const top = editAnalysis(a, { bpm: 999.94 })
  assert.equal(top.bpm, 999.9)
  assert.equal(top.edited, true)
})
