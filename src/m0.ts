// M0 측정 페이지: 아이폰에서 디코드·분석 시간과 메모리, 시간축, 여러 파일 공유를 잰다.
// 기록은 localStorage에 남겨서, 탭이 강제 종료돼 다시 열려도 앞선 측정과 중단 지점이 보이게 한다.
import { SAMPLE_RATE, type AnalysisResult, type ChordSegment, type RhythmMethod } from './analysis.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = $<HTMLInputElement>('file')
const runButton = $<HTMLButtonElement>('run')
const progress = $('progress')
const audio = $<HTMLAudioElement>('audio')

const REPORT_KEY = 'm0-report'
const RUNNING_KEY = 'm0-running' // 실행 중 단계. 다음 로드 때 남아 있으면 탭이 죽은 것
const report = new Map<string, string>(JSON.parse(localStorage.getItem(REPORT_KEY) ?? '[]'))

function set(label: string, value: string) {
  report.set(label, value)
  localStorage.setItem(REPORT_KEY, JSON.stringify([...report]))
  $('report').replaceChildren(
    ...[...report].map(([k, v]) => {
      const tr = document.createElement('tr')
      const th = document.createElement('th')
      const td = document.createElement('td')
      th.textContent = k
      td.textContent = v
      tr.append(th, td)
      return tr
    }),
  )
}

const ms = (since: number) => `${Math.round(performance.now() - since)}ms`

$('build').textContent = __BUILD_ID__
set('빌드', __BUILD_ID__)
set('UA', navigator.userAgent)
set('홈 화면 모드', String(matchMedia('(display-mode: standalone)').matches))

const unfinished = localStorage.getItem(RUNNING_KEY)
if (unfinished) {
  localStorage.removeItem(RUNNING_KEY)
  set(`중단 감지 ${new Date().toLocaleTimeString()}`, unfinished)
  $('crash').hidden = false
  $('crash').textContent = `이전 분석이 끝나지 않았습니다: ${unfinished} (탭이 강제 종료됐을 가능성)`
}

/** 채널 평균으로 모노를 만든다. total이 원본보다 길면 원본을 반복해서 채운다(메모리 상한 시험용). */
function toMono(decoded: AudioBuffer, total: number): Float32Array {
  const mono = new Float32Array(total)
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c))
  const n = Math.min(decoded.length, total)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    mono[i] = sum / channels.length
  }
  for (let i = n; i < total; i += n) mono.copyWithin(i, 0, Math.min(n, total - i))
  return mono
}

let runNo = Number(localStorage.getItem('m0-run-no') ?? 0)
let decodedDuration = 0

async function run() {
  const file = fileInput.files?.[0]
  if (!file) return alert('파일을 먼저 고르세요')
  const method = $<HTMLSelectElement>('method').value as RhythmMethod
  const minutes = Number($<HTMLSelectElement>('length').value)
  runNo += 1
  localStorage.setItem('m0-run-no', String(runNo))
  const tag = `#${runNo}`
  const mark = (stage: string) => localStorage.setItem(RUNNING_KEY, `${tag} ${stage} · ${method} · ${minutes || '원본'}분 · ${file.name}`)
  set(`${tag} 조건`, `${file.name} (${(file.size / 2 ** 20).toFixed(1)}MB) · ${method} · 길이 ${minutes ? `${minutes}분` : '원본'}`)
  runButton.disabled = true
  progress.textContent = '디코드 중…'
  const t0 = performance.now()

  try {
    mark('디코드')
    let t = performance.now()
    let decoded: AudioBuffer | null = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer())
    decodedDuration = decoded.duration
    set(`${tag} 디코드`, `${ms(t)} · ${decoded.numberOfChannels}ch ${decoded.sampleRate}Hz ${decoded.duration.toFixed(3)}초`)

    mark('모노 변환')
    t = performance.now()
    const mono = toMono(decoded, minutes ? minutes * 60 * SAMPLE_RATE : decoded.length)
    decoded = null // 분석하는 동안 스테레오 버퍼를 붙잡고 있지 않게 한다
    set(`${tag} 모노 변환`, `${ms(t)} · 신호 ${(mono.length / SAMPLE_RATE / 60).toFixed(1)}분 ${(mono.byteLength / 2 ** 20).toFixed(0)}MB`)

    mark('워커 로드')
    t = performance.now()
    const worker = new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module' })
    const result = await new Promise<AnalysisResult>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || '워커 오류'))
      worker.onmessage = (e) => {
        const m = e.data
        if (m.type === 'ready') {
          set(`${tag} 워커 로드`, `${ms(t)} · 힙 ${m.heapMB}MB`)
          mark('분석 시작')
          t = performance.now()
          worker.postMessage({ signal: mono, method }, [mono.buffer]) // 복사 없이 넘긴다
        } else if (m.type === 'progress') {
          progress.textContent = `${m.stage} ${Math.round(m.ratio * 100)}% · WASM 힙 ${m.heapMB}MB`
          mark(`분석 ${m.stage}`)
        } else if (m.type === 'done') {
          set(`${tag} WASM 힙 최종`, `${m.heapMB}MB`)
          resolve(m.result)
        } else {
          reject(new Error(m.message))
        }
      }
    })
    worker.terminate()

    const r = result
    set(`${tag} 분석`, `${ms(t)} (리듬 ${r.times.rhythm} · 조성 ${r.times.key} · HPCP ${r.times.hpcp} · 코드 ${r.times.chords}ms)`)
    set(`${tag} 결과`, `BPM ${r.bpm.toFixed(1)} (conf ${r.bpmConfidence.toFixed(2)}, 비트 ${r.ticks.length}) · ${r.key} ${r.scale} (${r.keyStrength.toFixed(2)}) · 코드 구간 ${r.chords.length}`)
    set(`${tag} 전체`, ms(t0))
    progress.textContent = '완료'
    showPlayback(file, r)
  } catch (err) {
    set(`${tag} 오류`, String(err))
    progress.textContent = `오류: ${err}`
  } finally {
    localStorage.removeItem(RUNNING_KEY)
    runButton.disabled = false
  }
}

// --- 재생하며 비트·코드 동기화 확인 (MAPP에서 쓸 방식: rAF로 currentTime을 읽고 이진 탐색) ---
let ticks: number[] = []
let chords: ChordSegment[] = []
let chordStarts: number[] = []

function lastAtOrBefore(xs: number[], t: number) {
  let lo = 0
  let hi = xs.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= t) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

function showPlayback(file: File, r: AnalysisResult) {
  ticks = r.ticks
  chords = r.chords
  chordStarts = chords.map((c) => c.start)
  $('chordList').textContent = chords.slice(0, 60).map((c) => `${c.start.toFixed(1)} ${c.chord}`).join(' · ')
  if (audio.src) URL.revokeObjectURL(audio.src)
  audio.src = URL.createObjectURL(file)
}

audio.addEventListener('loadedmetadata', () => {
  if (decodedDuration) {
    const diff = (audio.duration - decodedDuration) * 1000
    set('시간축 길이 차이', `${diff.toFixed(1)}ms (audio ${audio.duration.toFixed(3)}초 − 디코드 ${decodedDuration.toFixed(3)}초)`)
  }
})

let lastBeat = -1
function frame() {
  if (audio.paused) return
  const t = audio.currentTime
  const beat = lastAtOrBefore(ticks, t)
  if (beat !== lastBeat) {
    lastBeat = beat
    const el = $('beat')
    el.classList.remove('on')
    void el.offsetWidth // 애니메이션을 처음부터 다시 시작
    el.classList.add('on')
  }
  const c = lastAtOrBefore(chordStarts, t)
  $('now').textContent = chords[c]?.chord ?? '-'
  $('next').textContent = chords[c + 1] ? `→ ${chords[c + 1].chord}` : ''
  requestAnimationFrame(frame)
}
audio.addEventListener('play', () => requestAnimationFrame(frame))

// --- 여러 파일 공유: 파일 준비는 동기로 끝내고, 탭 핸들러 안에서 바로 share를 부른다 ---
async function shareCopies(n: number) {
  const file = fileInput.files?.[0]
  if (!file) return alert('파일을 먼저 고르세요')
  const files = Array.from(
    { length: n },
    (_, i) => new File([file], `m0-share-${String(i + 1).padStart(2, '0')}.m4a`, { type: 'audio/mp4' }),
  )
  if (!navigator.canShare?.({ files })) return set(`공유 ${n}개`, 'canShare=false')
  try {
    await navigator.share({ files })
    set(`공유 ${n}개`, '공유 시트 완료 (파일 앱에서 저장 여부 확인)')
  } catch (err) {
    set(`공유 ${n}개`, `${(err as Error).name}: ${(err as Error).message}`)
  }
}

runButton.addEventListener('click', run)
$('share1').addEventListener('click', () => shareCopies(1))
$('share10').addEventListener('click', () => shareCopies(10))
$('copy').addEventListener('click', async () => {
  const text = [...report].map(([k, v]) => `${k}: ${v}`).join('\n')
  const box = $<HTMLTextAreaElement>('copyText')
  box.value = text
  box.hidden = false // 클립보드가 막히면 여기서 길게 눌러 복사
  try {
    await navigator.clipboard.writeText(text)
    $('copy').textContent = '복사됨'
  } catch {
    box.select()
  }
})
$('clear').addEventListener('click', () => {
  if (!confirm('기록을 모두 지울까요?')) return
  localStorage.removeItem(REPORT_KEY)
  localStorage.removeItem('m0-run-no')
  location.reload()
})
