// 스모크 테스트: 한 곡을 넣어 B 화면에서 저장(다운로드)까지 간다. 외부 요청은 모두 고정한다.
// 사용: npm run test:e2e (빌드가 먼저 끝나 있어야 한다)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { readTags } from '../src/mp4.ts'
import { parseAnalysis } from '../src/schema.ts'
import { ffmpeg, makeImage } from '../src/testing.ts'

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
  // 1초마다 비프음이 나는 12초 픽스처: 분석이 BPM·코드를 낼 수 있게 한다.
  const fixture = (name: string) => {
    const path = join(dir, name)
    ffmpeg(
      '-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:duration=12',
      '-c:a', 'aac',
      '-metadata', 'title=Lee Juck(이적) _ running on the sky(하늘을 달리다)',
      '-metadata', 'artist=1theK (원더케이)',
      '-metadata', 'album=1theK (원더케이)',
      '-movflags', '+faststart',
      path,
    )
    return path
  }
  const input = fixture(FILE_NAME)

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

    // 한 곡이므로 B 화면으로 바로 간다. 조회가 끝나 후보 행이 나올 때까지 기다린다.
    await page.getByRole('button', { name: /Running on the Sky/ }).waitFor()
    assert.equal(await page.getByLabel('제목').inputValue(), '하늘을 달리다')
    assert.equal(await page.getByLabel('가수').inputValue(), '이적')
    assert.equal(await page.getByLabel('앨범').inputValue(), '2적')

    // 12초짜리 픽스처와 iTunes 263초의 차이. +251초.
    const candidate = page.getByRole('button', { name: /Running on the Sky/ })
    const candidateText = await candidate.innerText()
    assert.match(candidateText, /Running on the Sky/)
    assert.match(candidateText, /\+251초/)
    const lyricsRow = page.getByRole('button', { name: /가사/ })
    assert.match(await lyricsRow.innerText(), /일반 ✓ · 싱크 ✓/)
    assert.match(await lyricsRow.innerText(), /두근거렸지/)

    // 가사 시트 맨 위에 지금 들어 있는 가사가 보인다.
    await lyricsRow.click()
    const current = page.getByLabel('지금 가사')
    assert.match(await current.innerText(), /두근거렸지/)
    await page.getByText('싱크 가사 있음').waitFor()
    await page.getByRole('button', { name: '닫기' }).click()

    // 분석 카드가 BPM을 보여 줄 때까지 기다린다(Chrome에서 진짜 분석이 돈다).
    await page.getByText('분석 (참고용)').waitFor()
    await page.getByLabel('BPM 직접 입력').waitFor({ timeout: 60_000 })
    // 분석이 끝나면 상태가 '분석 완료, 저장 필요'로 바뀐다.
    await page.getByText('분석 완료, 저장 필요').waitFor()

    const save = async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '저장 · 공유' }).click(),
      ])
      assert.equal(download.suggestedFilename(), '이적 - 하늘을 달리다.m4a')
      return readTags(new Uint8Array(readFileSync((await download.path())!)))
    }

    const tags = await save()
    assert.equal(tags.title, '하늘을 달리다')
    assert.equal(tags.artist, '이적')
    assert.equal(tags.album, '2적')
    assert.equal(tags.lyrics, '두근거렸지')
    assert.equal(tags.lrc, '[00:01.00]두근거렸지')
    assert.deepEqual(tags.cover, COVER)
    const analysis = parseAnalysis(tags.analysis)
    assert.ok(analysis, '저장한 파일에 v1 ANALYSIS가 있어야 해요')
    assert.equal(analysis.version, 1)
    assert.ok(analysis.bpm > 0)
    assert.ok(analysis.chords.length > 0)
    console.log(`분석: bpm ${analysis.bpm}, key ${analysis.key} ${analysis.scale}, chords ${analysis.chords.length}`)

    // [×2]를 누르고 다시 저장하면 파일의 bpm이 두 배이고 edited가 true다.
    await page.getByRole('button', { name: '×2' }).click()
    const doubled = parseAnalysis((await save()).analysis)
    assert.ok(doubled)
    assert.equal(doubled.bpm, Math.round(analysis.bpm * 20) / 10)
    assert.equal(doubled.edited, true)

    await page.getByRole('button', { name: /큐/ }).click()
    await page.getByText('저장됨').waitFor()

    // [모두 저장]: 두 곡을 더 넣고 큐에서 한 번에 저장한다. 이번에는 공유 시트 경로를 쓴다(아이폰과 같은 경로).
    await page.evaluate(() => {
      const nav = navigator as unknown as Record<string, unknown>
      nav.canShare = () => true
      nav.share = async ({ files }: { files: File[] }) => {
        ;(window as unknown as Record<string, unknown>).__shared = await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: [...new Uint8Array(await f.arrayBuffer())] })),
        )
      }
    })
    await page.locator('input[type=file]').setInputFiles([fixture('a.m4a'), fixture('b.m4a')])
    const saveAll = page.getByRole('button', { name: '모두 저장 (2곡)' })
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent === '모두 저장 (2곡)' && !b.disabled),
      undefined,
      { timeout: 60_000 },
    )
    await saveAll.click()
    await page.waitForFunction(() => '__shared' in window)
    const shared = (await page.evaluate(() => (window as unknown as Record<string, unknown>).__shared)) as {
      name: string
      bytes: number[]
    }[]
    // 두 곡이 같은 이름이 되므로 뒤의 것에 번호가 붙는다.
    assert.deepEqual(shared.map((f) => f.name), ['이적 - 하늘을 달리다.m4a', '이적 - 하늘을 달리다 (2).m4a'])
    for (const f of shared) assert.ok(parseAnalysis(readTags(new Uint8Array(f.bytes)).analysis), `${f.name}에 분석이 있어야 해요`)
    await page.waitForFunction(() => document.body.innerText.split('저장됨').length - 1 === 3)
    assert.equal(await saveAll.count(), 0)
    // 저장된 곡은 큐에서 한 번에 뺄 수 있다.
    await page.getByRole('button', { name: '저장된 곡 지우기 (3곡)' }).click()
    assert.equal(await page.getByText('저장됨').count(), 0)
    assert.equal(await page.getByRole('button', { name: '삭제' }).count(), 0)

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
