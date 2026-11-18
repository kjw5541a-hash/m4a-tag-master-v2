// 출력 파일 만들기와 저장(공유 시트 또는 다운로드).
import { verify, writeTags } from './mp4.ts'
import { outputName, toTags, type Edit, type Source } from './edit.ts'

// 동기 함수여야 한다. 저장 탭 핸들러 안에서 await 없이 끝내야 공유 권한(사용자 제스처)이 유지된다.
// 검증(verify)에 실패하면 그 오류를 그대로 던진다.
export function buildOutput(src: Source, e: Edit): File {
  const tags = toTags(e, src)
  const out = writeTags(src.bytes, tags)
  verify(src.bytes, out, tags)
  // writeTags가 새로 만든 ArrayBuffer라 BlobPart 타입에 맞춰 좁힌다.
  return new File([out as Uint8Array<ArrayBuffer>], outputName(e, src.fileName), { type: 'audio/mp4' })
}

// 공유 시트를 우선하고, 안 되면 다운로드한다. NotAllowedError 등은 호출한 쪽이 처리하도록 그대로 던진다.
export async function shareOrDownload(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] }) // title·text는 넣지 않는다.
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      throw e
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  // 클릭 직후 바로 지우면 다운로드가 끊기는 브라우저가 있어 잠시 뒤에 지운다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
