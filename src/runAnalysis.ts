// 브라우저 분석 실행기: m4a 바이트 → 디코드 → 모노 → 곡마다 새 워커 → 워치독 → 스키마 v1.
// 브라우저 전용 전역(OfflineAudioContext·Worker)은 함수 안에서만 쓴다. Node 테스트가 이 파일을 import해도 throw하지 않게 하려는 것.
import { SAMPLE_RATE, toAnalysis, type AnalysisResult } from './analysis.ts'
import type { MappAnalysisV1 } from './schema.ts'

export const MAX_ANALYSIS_SEC = 15 * 60
const WATCHDOG_MS = 60_000 // 워커에서 이만큼 메시지가 없으면 멈춘 것으로 본다

/** 메시지는 화면에 그대로 보여 준다. */
export class AnalysisError extends Error {}

// 워커 단계별 진행률 구간(0~1 하나로 묶는다)
const STAGE_RANGE: Record<string, [number, number]> = {
  rhythm: [0, 0.5],
  key: [0.5, 0.55],
  hpcp: [0.55, 0.95],
  chords: [0.95, 1],
}

// 디코드해서 채널 평균 모노로 만든다. AudioBuffer는 이 함수가 끝나면 버려진다.
async function decodeMono(bytes: Uint8Array): Promise<{ signal: Float32Array; durationSec: number }> {
  let decoded: AudioBuffer
  try {
    decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes.slice().buffer) // 복사본: 원본을 떼어 가지 않는다
  } catch {
    throw new AnalysisError('오디오를 해석하지 못해 분석을 건너뜁니다')
  }
  if (decoded.duration > MAX_ANALYSIS_SEC) {
    throw new AnalysisError('분석은 15분 이하 곡만 할 수 있어요. 태그는 저장할 수 있어요')
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c))
  const signal = new Float32Array(decoded.length)
  for (let i = 0; i < signal.length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i]
    signal[i] = sum / channels.length
  }
  return { signal, durationSec: decoded.duration }
}

// WASM 힙은 줄어들지 않으므로 곡마다 워커를 새로 만들고, 어떤 경로로 끝나든 terminate()한다.
function analyzeInWorker(signal: Float32Array, onProgress: (ratio: number) => void): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      settle()
    }
    const fail = () => finish(() => reject(new AnalysisError('분석 중 메모리가 부족했어요')))
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(fail, WATCHDOG_MS)
    }

    arm()
    worker.onerror = fail
    worker.onmessage = (e) => {
      if (settled) return
      arm() // 메시지가 올 때마다 워치독을 다시 건다
      const m = e.data
      if (m.type === 'ready') {
        worker.postMessage({ signal, method: 'multifeature' }, [signal.buffer]) // 복사 없이 넘긴다
      } else if (m.type === 'progress') {
        const range = STAGE_RANGE[m.stage]
        if (range) onProgress(range[0] + (range[1] - range[0]) * m.ratio)
      } else if (m.type === 'done') {
        finish(() => resolve(m.result))
      } else if (m.type === 'error') {
        fail()
      }
    }
  })
}

export async function runAnalysis(bytes: Uint8Array, onProgress: (ratio: number) => void): Promise<MappAnalysisV1> {
  const { signal, durationSec } = await decodeMono(bytes)
  const result = await analyzeInWorker(signal, onProgress)
  return toAnalysis(result, durationSec, new Date().toISOString())
}
