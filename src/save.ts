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

export interface Built {
  id: string
  edit: Edit
  file: File
}

/**
 * 여러 곡의 출력 파일을 만든다(동기: 탭 핸들러 안에서 바로 공유하려고). 검증에 실패한 곡은 빼고 이유를 돌려준다.
 * prev에 같은 곡·같은 편집값(객체 그대로)으로 만든 파일이 있으면 다시 쓴다. NotAllowedError 뒤 다시 누를 때 곧바로 공유가 열리게 하려는 것.
 * 한 번에 넘기는 파일 이름이 겹치면 뒤의 것에 ' (2)'처럼 번호를 붙인다.
 */
export function buildBatch(
  items: { id: string; source: Source; edit: Edit }[],
  prev: Built[] = [],
): { built: Built[]; failed: { id: string; message: string }[] } {
  const built: Built[] = []
  const failed: { id: string; message: string }[] = []
  const used = new Set<string>()
  for (const { id, source, edit } of items) {
    let file = prev.find((p) => p.id === id && p.edit === edit)?.file
    if (!file) {
      try {
        file = buildOutput(source, edit)
      } catch (err) {
        failed.push({ id, message: err instanceof Error ? err.message : String(err) })
        continue
      }
    }
    const base = outputName(edit, source.fileName).replace(/\.m4a$/, '')
    let name = `${base}.m4a`
    for (let n = 2; used.has(name); n++) name = `${base} (${n}).m4a`
    used.add(name)
    if (file.name !== name) file = new File([file], name, { type: file.type })
    built.push({ id, edit, file })
  }
  return { built, failed }
}

/** 공유 한 번에 넘기는 최대 파일 수. 10개 넘게 한 번에 공유하는 것은 실기기에서 확인하지 못했다(기획서 5.7). */
export const SHARE_BATCH = 10

// 공유 시트를 우선하고(파일 여러 개를 한 번에), 안 되면 파일마다 다운로드한다. NotAllowedError 등은 호출한 쪽이 처리하도록 그대로 던진다.
export async function shareOrDownload(files: File[]): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files }) // title·text는 넣지 않는다.
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      throw e
    }
  }
  for (const file of files) {
    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    // 클릭 직후 바로 지우면 다운로드가 끊기는 브라우저가 있어 잠시 뒤에 지운다.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return 'downloaded'
}

/** 공유·다운로드가 실패했을 때 화면에 보여 줄 문구. 만든 파일은 그대로 두므로 다시 누르면 된다. */
export function saveErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  return name === 'NotAllowedError' ? '저장 버튼을 한 번 더 눌러 주세요' : `저장하지 못했어요 (${name || '알 수 없는 오류'})`
}
