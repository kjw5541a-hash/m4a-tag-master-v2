// 커버 이미지 크기 읽기. 디코드하지 않고 헤더만 본다.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** PNG는 IHDR, JPEG는 SOF에서 크기를 읽는다. 그 밖의 형식이나 깨진 데이터면 undefined. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (PNG_SIGNATURE.every((x, i) => bytes[i] === x)) {
    // 시그니처 8 + 길이 4 + 'IHDR' 4 다음에 너비·높이
    return bytes.length >= 24 ? { width: v.getUint32(16), height: v.getUint32(20) } : undefined
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let p = 2
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return undefined
    const marker = bytes[p + 1]
    if (marker === 0xff) { // 채움 바이트
      p++
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { // 길이 없는 마커
      p += 2
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { // SOF0~15
      return p + 9 <= bytes.length ? { width: v.getUint16(p + 7), height: v.getUint16(p + 5) } : undefined
    } else if (marker === 0xd9 || marker === 0xda) { // SOF 없이 EOI·SOS에 닿음
      return undefined
    } else {
      p += 2 + v.getUint16(p + 2)
    }
  }
  return undefined
}

export function isSquare(bytes: Uint8Array): boolean {
  const size = imageSize(bytes)
  return size !== undefined && size.width === size.height
}
