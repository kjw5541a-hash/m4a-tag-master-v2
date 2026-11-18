// 분석 워커: 메인 스레드가 넘긴 44.1kHz 모노 신호를 essentia.js로 분석한다.
// WASM 힙은 줄어들지 않으므로 메인 스레드가 곡마다 워커를 새로 만들고 끝나면 종료한다.
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js'
import Essentia from 'essentia.js/dist/essentia.js-core.es.js'
import { analyze, type RhythmMethod } from './analysis.ts'

const essentia = new Essentia(EssentiaWASM)
const heapMB = () => Math.round(EssentiaWASM.HEAPU8.buffer.byteLength / 2 ** 20)
const scope = self as unknown as Worker // postMessage(message, transfer) 시그니처가 같다

scope.postMessage({ type: 'ready', heapMB: heapMB() })

scope.onmessage = (e: MessageEvent<{ signal: Float32Array; method: RhythmMethod }>) => {
  try {
    const result = analyze(essentia, e.data.signal, e.data.method, (stage, ratio) =>
      scope.postMessage({ type: 'progress', stage, ratio, heapMB: heapMB() }),
    )
    scope.postMessage({ type: 'done', result, heapMB: heapMB() })
  } catch (err) {
    scope.postMessage({ type: 'error', message: String(err) })
  }
}
