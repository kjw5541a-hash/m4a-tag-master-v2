// 정확도 평가 (기획서 11.2): 정답 CSV(file,bpm,key)와 m4a 폴더를 받아 BPM·조성 판정을 센다.
// 사용: npm run evaluate -- <m4a 폴더> <정답 CSV>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { analyze, SAMPLE_RATE } from '../src/analysis.ts'
import { PITCH_CLASSES } from '../src/schema.ts'

export type BpmVerdict = 'ok' | 'double' | 'half' | 'wrong'
export type KeyVerdict = 'exact' | 'relative' | 'fifth' | 'wrong'

const near = (a: number, b: number) => Math.abs(a - b) <= b * 0.02

export function bpmVerdict(got: number, want: number): BpmVerdict {
  if (near(got, want)) return 'ok'
  if (near(got, want * 2)) return 'double'
  if (near(got, want / 2)) return 'half'
  return 'wrong'
}

const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' }

// 'F# minor' / 'Gb minor' → 근음 번호(0~11)와 scale
function parseKey(s: string) {
  const m = /^([A-G][#b]?)\s+(major|minor)$/.exec(s.trim())
  if (!m) throw new Error(`조성 형식 오류: "${s}" (예: F# minor)`)
  const pc = PITCH_CLASSES.indexOf((FLATS[m[1]] ?? m[1]) as (typeof PITCH_CLASSES)[number])
  if (pc < 0) throw new Error(`알 수 없는 음 이름: "${s}"`)
  return { pc, scale: m[2] }
}

export function keyVerdict(got: string, want: string): KeyVerdict {
  const g = parseKey(got)
  const w = parseKey(want)
  const diff = (g.pc - w.pc + 12) % 12
  if (g.scale === w.scale) {
    if (diff === 0) return 'exact'
    return diff === 7 || diff === 5 ? 'fifth' : 'wrong'
  }
  // 나란한조: 단조 근음 = 장조 근음 - 3반음
  const [major, minor] = g.scale === 'major' ? [g.pc, w.pc] : [w.pc, g.pc]
  return minor === (major + 9) % 12 ? 'relative' : 'wrong'
}

// 최소 CSV: 머리글 file,bpm,key / 쉼표 구분 / 따옴표 없음
export function parseCsv(text: string) {
  const [, ...lines] = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  return lines.map((l) => {
    const [file, bpm, key] = l.split(',').map((c) => c.trim())
    return { file, bpm: Number(bpm), key }
  })
}

if (import.meta.main) {
  const [dir, csv] = process.argv.slice(2)
  if (!dir || !csv) throw new Error('사용: npm run evaluate -- <m4a 폴더> <정답 CSV>')

  // ES 빌드는 Node에서 깨지므로 UMD 빌드를 쓴다 (check-analysis.ts와 동일)
  const { EssentiaWASM, Essentia } = createRequire(import.meta.url)('essentia.js')
  const essentia = new Essentia(EssentiaWASM)

  const count: Record<string, number> = {}
  const tally = (k: string) => (count[k] = (count[k] ?? 0) + 1)
  const rows = parseCsv(readFileSync(csv, 'utf8'))

  for (const row of rows) {
    const pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', join(dir, row.file), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
      { maxBuffer: 1 << 30 },
    )
    const signal = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
    const r = analyze(essentia, signal)
    const key = `${r.key} ${r.scale}`
    const bv = bpmVerdict(r.bpm, row.bpm)
    const kv = keyVerdict(key, row.key)
    tally(`bpm:${bv}`)
    tally(`key:${kv}`)
    console.log(`${row.file}  BPM 정답 ${row.bpm} / 결과 ${r.bpm.toFixed(1)} → ${bv}  |  조성 정답 ${row.key} / 결과 ${key} → ${kv}`)
  }

  const c = (k: string) => count[k] ?? 0
  console.log(`\n요약 (${rows.length}곡)`)
  console.log(`BPM  ok ${c('bpm:ok')}, double ${c('bpm:double')}, half ${c('bpm:half')}, wrong ${c('bpm:wrong')}`)
  console.log(`조성 exact ${c('key:exact')}, relative ${c('key:relative')}, fifth ${c('key:fifth')}, wrong ${c('key:wrong')}`)
}
