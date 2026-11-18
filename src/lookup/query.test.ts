// 검색어 정리 테스트 (기획서 5.2). 파일명·태그 → 표시용 가수/제목 + iTunes 검색어.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSource, normalizeName } from './query.ts'

const ONE_THE_K = '1theK (원더케이) - Lee Juck(이적) _ running on the sky(하늘을 달리다).m4a'
const LEE = {
  artist: '이적',
  title: '하늘을 달리다',
  queries: ['Lee Juck running on the sky', '이적 하늘을 달리다'],
}

const nfd = '김동률 - 산책.m4a'.normalize('NFD')
assert.notEqual(nfd, nfd.normalize('NFC'), '테스트 입력이 NFD여야 한다')

const rows: [string, string, { title?: string; artist?: string }, typeof LEE][] = [
  [
    '1. 채널 접두 + 태그 제목에 구분자',
    ONE_THE_K,
    { title: 'Lee Juck(이적) _ running on the sky(하늘을 달리다)', artist: '1theK (원더케이)' },
    LEE,
  ],
  ['2. 태그 없이 파일명만(채널 접두 제거)', ONE_THE_K, {}, LEE],
  [
    '3. iOS 중복 번호는 뗀 검색어가 먼저, 붙인 검색어가 셋째',
    '김동률 - 산책 2.m4a',
    {},
    { artist: '김동률', title: '산책', queries: ['김동률 산책', '김동률 산책 2'] },
  ],
  [
    '4. 따옴표 제목 + 가수 토큰을 글자 종류별로 묶기 + MV 잡음',
    "aespa 에스파 'Whiplash' MV.m4a",
    {},
    { artist: '에스파', title: 'Whiplash', queries: ['aespa Whiplash', '에스파 Whiplash'] },
  ],
  [
    '5. NFD 입력은 NFC로',
    nfd,
    {},
    { artist: '김동률', title: '산책', queries: ['김동률 산책'] },
  ],
  [
    '6. [MV] 묶음 통째로 제거',
    'IU(아이유) - Love wins all [MV].m4a',
    {},
    {
      artist: '아이유',
      title: 'Love wins all',
      queries: ['IU Love wins all', '아이유 Love wins all'],
    },
  ],
  ['7. 구분자 없으면 전체가 제목', '산책.m4a', {}, { artist: '', title: '산책', queries: ['산책'] }],
  [
    '8. 4Kings의 4K는 잡음이 아니다(단어 경계)',
    '4Kings - Thunder.m4a',
    {},
    { artist: '4Kings', title: 'Thunder', queries: ['4Kings Thunder'] },
  ],
  [
    '9. 태그 제목에 구분자가 없으면 태그 가수',
    '이적 - 하늘을 달리다.m4a',
    { title: '하늘을 달리다', artist: '이적' },
    { artist: '이적', title: '하늘을 달리다', queries: ['이적 하늘을 달리다'] },
  ],
]

for (const [name, fileName, tags, want] of rows) {
  test(`parseSource ${name}`, () => {
    assert.deepEqual(parseSource(fileName, tags), want)
  })
}

test('normalizeName: 소문자, 공백·구두점 제거', () => {
  assert.equal(normalizeName(' Lee  Juck! '), 'leejuck')
  assert.equal(normalizeName('이 적'), '이적')
})
