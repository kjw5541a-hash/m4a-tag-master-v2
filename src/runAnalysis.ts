// 브라우저 분석 실행기: m4a 바이트 → 디코드 → 모노 → 곡마다 새 워커 → 워치독 → 스키마 v1.
// 브라우저 전용 전역(OfflineAudioContext·Worker)은 함수 안에서만 쓴다. Node 테스트가 이 파일을 import해도 throw하지 않게 하려는 것.
import { SAMPLE_RATE, toAnalysis, type AnalysisResult, type BeatChroma } from './analysis.ts'
import { audioTrack } from './mp4.ts'
import type { MappAnalysisV1 } from './schema.ts'

export const MAX_ANALYSIS_SEC = 15 * 60
export const TOO_LONG = '분석은 15분 이하 곡만 할 수 있어요. 태그는 저장할 수 있어요'
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

/** 디코드 실패 원인을 사람이 읽을 짧은 문구로. */
export function decodeFailureReason(e: unknown): string {
  if (e instanceof Error && e.message === DECODE_TIMEOUT) return '60초 넘게 걸림'
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  return text.slice(0, 80) || '원인 모름'
}

const DECODE_TIMEOUT = 'decode timeout'

type Mono = { signal: Float32Array; durationSec: number }

// 디코드해서 채널 평균 모노로 만든다.
// WebCodecs를 먼저 쓰고, 쓸 수 없으면 decodeAudioData로 한다. 두 단계 합쳐 WATCHDOG_MS를 넘기면 실패로 본다.
async function decodeMono(bytes: Uint8Array): Promise<Mono> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let mono: Mono
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(DECODE_TIMEOUT)), WATCHDOG_MS)
    })
    const fast = await Promise.race([
      decodeWithWebCodecs(bytes).catch((e) => {
        console.warn('WebCodecs 디코드 실패, decodeAudioData로 다시 시도', e)
        return undefined
      }),
      deadline,
    ])
    mono = fast ?? (await Promise.race([decodeWithAudioContext(bytes), deadline]))
  } catch (e) {
    // 원인을 화면에도 짧게 붙인다. 아이폰에서는 콘솔을 보기 어려워 실패 원인을 알 길이 없기 때문이다.
    console.warn('디코드 실패', e)
    throw new AnalysisError(`오디오를 해석하지 못해 분석을 건너뜁니다 (${decodeFailureReason(e)})`)
  } finally {
    clearTimeout(timer)
  }
  if (mono.durationSec > MAX_ANALYSIS_SEC) throw new AnalysisError(TOO_LONG)
  return mono
}

/**
 * AAC 프레임을 하나씩 WebCodecs로 디코드하며 바로 모노로 합친다. 쓸 수 없는 환경·형식이면 undefined.
 * Safari의 decodeAudioData는 긴 곡에서 매우 느리다(Mac WebKit 실측: 3분 1.1초, 11분 48초, 15분 92초).
 * 이 방식은 같은 파일이 11분 1.4초, 15분 2.1초였고, 스테레오 전체를 메모리에 올리지 않는다.
 */
async function decodeWithWebCodecs(bytes: Uint8Array): Promise<Mono | undefined> {
  if (typeof AudioDecoder === 'undefined') return undefined
  const track = audioTrack(bytes)
  // 분석은 44.1kHz 전제라, 다른 샘플레이트는 다시 샘플링해 주는 decodeAudioData에 맡긴다.
  if (!track.codec.startsWith('mp4a') || !track.config || track.sampleRate !== SAMPLE_RATE) return undefined
  const config = { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels, description: track.config }
  if (!(await AudioDecoder.isConfigSupported(config)).supported) return undefined

  let signal = new Float32Array(track.sizes.length * 1024) // AAC-LC는 프레임당 1024샘플. 모자라면 늘린다
  let written = 0
  let failure: unknown
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        if (data.sampleRate !== SAMPLE_RATE) throw new Error(`출력 샘플레이트 ${data.sampleRate}`)
        const n = data.numberOfFrames
        if (written + n > signal.length) {
          const grown = new Float32Array(Math.max(signal.length * 2, written + n))
          grown.set(signal.subarray(0, written))
          signal = grown
        }
        const plane = new Float32Array(n)
        for (let c = 0; c < data.numberOfChannels; c++) {
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
          for (let i = 0; i < n; i++) signal[written + i] += plane[i] / data.numberOfChannels
        }
        written += n
      } catch (e) {
        failure ??= e
      } finally {
        data.close()
      }
    },
    error: (e) => {
      failure ??= e
    },
  })
  try {
    decoder.configure(config)
    const frameUs = Math.round((1024 * 1e6) / track.sampleRate)
    for (let i = 0; i < track.sizes.length && !failure; i++) {
      const data = bytes.subarray(track.offsets[i], track.offsets[i] + track.sizes[i])
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * frameUs, data }))
    }
    await decoder.flush()
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
  if (failure) throw failure
  return { signal: signal.subarray(0, written), durationSec: written / SAMPLE_RATE }
}

// 전체를 한 번에 디코드한다. AudioBuffer는 이 함수가 끝나면 버려진다.
async function decodeWithAudioContext(bytes: Uint8Array): Promise<Mono> {
  const decoded = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(bytes.slice().buffer) // 복사본: 원본을 떼어 가지 않는다
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
    worker.onerror = (e) => {
      console.warn('분석 워커 오류', e) // 원인은 Web Inspector에서 본다
      fail()
    }
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
        console.warn('분석 워커 오류', m.message) // 원인은 Web Inspector에서 본다
        fail()
      }
    }
  })
}

// chroma는 사용자가 BPM을 고칠 때 코드를 다시 묶는 데 쓴다(파일에는 넣지 않는다).
export async function runAnalysis(
  bytes: Uint8Array,
  onProgress: (ratio: number) => void,
): Promise<{ analysis: MappAnalysisV1; chroma?: BeatChroma }> {
  const { signal, durationSec } = await decodeMono(bytes)
  const result = await analyzeInWorker(signal, onProgress)
  return { analysis: toAnalysis(result, durationSec, new Date().toISOString()), chroma: result.beatChroma }
}
