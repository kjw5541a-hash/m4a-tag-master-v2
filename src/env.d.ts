declare const __BUILD_ID__: string

// essentia.js 0.1.3은 타입 선언을 제공하지 않는다.
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: any
}
declare module 'essentia.js/dist/essentia.js-core.es.js' {
  const Essentia: any
  export default Essentia
}
