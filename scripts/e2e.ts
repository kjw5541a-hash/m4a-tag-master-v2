// 스모크 테스트: 한 곡을 넣어 B 화면에서 저장(다운로드)까지 간다. 외부 요청은 모두 고정한다.
// 사용: npm run test:e2e (빌드가 먼저 끝나 있어야 한다)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { readTags } from '../src/mp4.ts'
import { makeImage, makeM4a } from '../src/testing.ts'

const ORIGIN = 'http://localhost:4174'
const FILE_NAME = '1theK (원더케이) - Lee Juck(이적) _ running on the sky(하늘을 달리다).m4a'

const ITUNES = {
  resultCount: 2,
  results: [
    {
      trackId: 1,
      artistName: 'Lee Juck',
      trackName: 'Running on the Sky',
      collectionName: '2적',
      trackTimeMillis: 263000,
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg',
    },
    {
      trackId: 2,
      artistName: 'Lee Juck',
      trackName: 'Run Across the Sky',
      collectionName: 'Do You Remember',
      trackTimeMillis: 265000,
    },
  ],
}

const LRCLIB_HIT = {
  id: 7,
  artistName: '이적',
  trackName: '하늘을 달리다',
  albumName: '2적',
  duration: 263,
  plainLyrics: '두근거렸지',
  syncedLyrics: '[00:01.00]두근거렸지',
}

const COVER = makeImage(32, 32, 'mjpeg')
const CORS = { 'access-control-allow-origin': '*' }

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${ORIGIN}/m4a-tag-master-v2/`).then((r) => r.ok, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('vite preview가 뜨지 않았어요')
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'm4a-e2e-'))
  const input = join(dir, FILE_NAME)
  writeFileSync(
    input,
    makeM4a(
      '-metadata', 'title=Lee Juck(이적) _ running on the sky(하늘을 달리다)',
      '-metadata', 'artist=1theK (원더케이)',
      '-metadata', 'album=1theK (원더케이)',
      '-movflags', '+faststart',
    ),
  )

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    // 서비스워커가 요청을 가로채지 않게 막는다.
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)

    // 저장 경로를 다운로드로 고정한다.
    await page.addInitScript(() => {
      delete (Navigator.prototype as Partial<Navigator>).share
      delete (Navigator.prototype as Partial<Navigator>).canShare
    })

    await page.route('**/itunes.apple.com/**', (r) => r.fulfill({ json: ITUNES, headers: CORS }))
    await page.route('**/*.mzstatic.com/**', (r) =>
      r.fulfill({ body: Buffer.from(COVER), contentType: 'image/jpeg', headers: CORS }),
    )
    await page.route('**/lrclib.net/api/get?**', (r) => r.fulfill({ status: 404, body: '', headers: CORS }))
    await page.route('**/lrclib.net/api/search?**', (r) => r.fulfill({ json: [LRCLIB_HIT], headers: CORS }))

    const errors: string[] = []
    const badResponses: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    // 의도한 LRCLIB 404는 Chrome이 'Failed to load resource'로 남기므로 거르고, 대신 앱 자신의 응답을 따로 본다.
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`)
    })
    page.on('response', (r) => {
      if (new URL(r.url()).origin === ORIGIN && r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`)
    })

    await page.goto(`${ORIGIN}/m4a-tag-master-v2/`)
    await page.locator('input[type=file]').setInputFiles(input)

    // 한 곡이므로 B 화면으로 바로 간다. 조회가 끝나 '확인 필요'가 될 때까지 기다린다.
    await page.getByText('확인 필요').waitFor()
    assert.equal(await page.getByLabel('제목').inputValue(), '하늘을 달리다')
    assert.equal(await page.getByLabel('가수').inputValue(), '이적')
    assert.equal(await page.getByLabel('앨범').inputValue(), '2적')

    // 3초짜리 사인파와 iTunes 263초의 차이. +260초.
    const candidate = page.getByRole('button', { name: /Running on the Sky/ })
    const candidateText = await candidate.innerText()
    assert.match(candidateText, /Running on the Sky/)
    assert.match(candidateText, /\+260초/)
    const lyricsRow = page.getByRole('button', { name: /가사/ })
    assert.match(await lyricsRow.innerText(), /일반 ✓ · 싱크 ✓/)
    assert.match(await lyricsRow.innerText(), /두근거렸지/)

    // 가사 시트 맨 위에 지금 들어 있는 가사가 보인다.
    await lyricsRow.click()
    const current = page.getByLabel('지금 가사')
    assert.match(await current.innerText(), /두근거렸지/)
    await page.getByText('싱크 가사 있음').waitFor()
    await page.getByRole('button', { name: '닫기' }).click()

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '저장 · 공유' }).click(),
    ])
    assert.equal(download.suggestedFilename(), '이적 - 하늘을 달리다.m4a')
    const tags = readTags(new Uint8Array(readFileSync((await download.path())!)))
    assert.equal(tags.title, '하늘을 달리다')
    assert.equal(tags.artist, '이적')
    assert.equal(tags.album, '2적')
    assert.equal(tags.lyrics, '두근거렸지')
    assert.equal(tags.lrc, '[00:01.00]두근거렸지')
    assert.deepEqual(tags.cover, COVER)

    await page.getByRole('button', { name: /큐/ }).click()
    await page.getByText('저장됨').waitFor()

    assert.deepEqual(errors, [])
    assert.deepEqual(badResponses, [])
  } finally {
    await browser.close()
  }
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4174', '--strictPort'], {
  stdio: 'ignore',
})
try {
  await waitForServer()
  await run()
  console.log('e2e 통과')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  server.kill()
}
