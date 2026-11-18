// 데스크톱 기준선 검증: ffmpeg로 44.1kHz 모노 PCM을 만든 뒤, 브라우저 워커와 같은 analyze()를 돌린다.
// 사용: npm run check:analysis -- <m4a 파일> [multifeature|degara]
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { analyze, SAMPLE_RATE, type RhythmMethod } from '../src/analysis.ts'

// ES 빌드는 Node에서 __dirname을 참조해 깨지므로, Node에서는 패키지 기본(UMD) 빌드를 쓴다.
const { EssentiaWASM, Essentia } = createRequire(import.meta.url)('essentia.js')

const file = process.argv[2]
if (!file) throw new Error('사용: npm run check:analysis -- <m4a 파일>')

const pcm = execFileSync(
  'ffmpeg',
  ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
  { maxBuffer: 1 << 30 },
)
const signal = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))

const essentia = new Essentia(EssentiaWASM)
const r = analyze(essentia, signal, (process.argv[3] as RhythmMethod) ?? 'multifeature')

const duration = signal.length / SAMPLE_RATE
console.log(`길이 ${duration.toFixed(2)}초, 프레임 ${r.frames}개`)
console.log(`BPM ${r.bpm.toFixed(1)} (confidence ${r.bpmConfidence.toFixed(2)}), 비트 ${r.ticks.length}개`)
console.log(`조성 ${r.key} ${r.scale} (strength ${r.keyStrength.toFixed(2)})`)
console.log(`코드 구간 ${r.chords.length}개, 처음 12개: ${r.chords.slice(0, 12).map((c) => c.chord).join(' ')}`)
console.log(`단계별 ms: ${JSON.stringify(r.times)}`)
console.log(`WASM 힙 ${(EssentiaWASM.HEAPU8.buffer.byteLength / 2 ** 20).toFixed(0)}MB`)

// 형식 검증: 값의 범위, 코드 표기, 구간이 시간 순으로 빈틈없이 이어지는지
assert.ok(r.bpm >= 40 && r.bpm <= 208, `BPM 범위 밖: ${r.bpm}`)
assert.ok(r.ticks.length > 10, '비트가 너무 적음')
assert.match(`${r.key} ${r.scale}`, /^[A-G]#? (major|minor)$/) // ♭ 표기는 #으로 통일돼야 함
assert.ok(r.chords.length > 0, '코드 구간 없음')
for (const [i, c] of r.chords.entries()) {
  assert.match(c.chord, /^([A-G]#?m?|N)$/, `코드 표기: ${c.chord}`)
  assert.ok(c.end > c.start, `구간 ${i} 길이 0 이하`)
  if (i > 0) assert.equal(c.start, r.chords[i - 1].end, `구간 ${i} 빈틈/겹침`)
  if (i > 0) assert.notEqual(c.chord, r.chords[i - 1].chord, `구간 ${i} 병합 안 됨`)
}
console.log('OK')
