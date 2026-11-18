# M2 단일 곡 플로우 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아이폰 Safari에서 m4a 하나를 골라 → 기존 태그 읽기·검색어 정리 → iTunes 후보·커버 → LRCLIB 가사 → 확인·수정 → 새 m4a로 저장·공유까지 끝낼 수 있게 한다(분석 제외). 기존 v1을 대체한다.

**Architecture:** 순수 로직(`src/lookup/*`, `src/edit.ts`, `src/save.ts`, `src/cover.ts`)은 Node `node:test`로 검증하고, 상태는 zustand 스토어(`src/store.ts`) 하나에 모은다. React 화면(큐 A, 곡 편집 B, 후보 시트 C, 가사 시트 D)은 스토어만 읽고 쓴다. MP4 쓰기는 이미 있는 `src/mp4.ts`(M1)를 쓴다. 화면 전체는 Playwright 스모크 스크립트 하나로 확인한다.

**Tech Stack:** Vite 8, React 19, TypeScript(erasable syntax only), Tailwind v4, zustand 5, vite-plugin-pwa 1, oxlint, Node 24 `node:test`, ffmpeg(테스트 파일 생성), playwright-core(스모크, 로컬 전용)

**Spec:** `~/Downloads/m4a_tag_master_v2_기획서.md` (저장소 밖 로컬 파일. 개인 정보가 있어 커밋하지 않는다). M2 범위는 5.1~5.4, 5.6 9번(파일명), 5.7, 5.9의 빌드 버전, 6.1~6.3, 8.4, 9장, 12장 M2 행.

## Global Constraints

- 서버 없음. 밖으로 나가는 데이터는 검색어뿐이고, 오디오는 전송하지 않는다.
- UI 문구와 코드 주석은 한국어.
- 입력란 글꼴 16px 이상, 터치 영역 44pt(px) 이상, `viewport-fit=cover`와 `env(safe-area-inset-*)`로 노치·홈 인디케이터 영역을 피한다.
- 파일 선택: `<input type="file" accept=".m4a,audio/mp4,audio/x-m4a" multiple>`.
- iTunes 요청: `https://itunes.apple.com/search?term=…&entity=song&limit=10&country=US`. 앱 전체에서 분당 20회 리미터.
- 네트워크: 타임아웃 8초, 실패하면 1번 다시 시도. 429나 5xx면 '검색 실패 · 다시 시도'를 보여 주고 수동 입력으로 계속 진행할 수 있다. 같은 URL 결과는 세션 동안 메모리에 캐시.
- 커버: `artworkUrl100`의 `100x100bb`를 `1000x1000bb`로 바꿔 받고, 받은 JPEG는 다시 인코딩하지 않는다. canvas 재인코딩은 '정사각형으로 자르기'를 고른 경우에만(JPEG 품질 0.92).
- `©lyr`에는 타임스탬프 없는 일반 가사만. 싱크 가사 원문은 `----:com.jw.mapp:LRC`(`Tags.lrc`).
- 저장: `navigator.share({ files })`에 `title`·`text`를 넣지 않는다. `AbortError`는 오류로 취급하지 않는다. `NotAllowedError`면 "저장 버튼을 한 번 더 눌러 주세요". `canShare`가 안 되면 `<a download>`.
- 파일명: `{가수} - {제목}.m4a`. `/ \ : * ? " < > |`는 지우고, NFC로 정규화하고, 확장자를 뺀 이름을 120자로 자른다.
- 원본 파일은 수정하지 않는다. 항상 새 파일을 만든다. 저장 전에 `verify`(M1)를 반드시 통과해야 한다.
- 빌드 버전 `__BUILD_ID__`를 화면에 표시한다.
- 공개 저장소: 실제 곡 파일을 커밋하지 않는다. 테스트용 m4a·이미지는 ffmpeg로 그때그때 만든다.
- 의존성은 이 계획에 적힌 것만 추가한다: react, react-dom, zustand / (dev) @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, vite-plugin-pwa, oxlint, @types/react, @types/react-dom, playwright-core.
- 테스트는 `node --test`가 TS를 그대로 실행하므로 상대 import에 `.ts` 확장자를 붙인다.

## Review Focus

- iOS 파일 앱의 한글 파일명은 NFD로 올 수 있다 → 검색어·표시 이름이 NFC여야 한다 (Task 2 테스트 5번).
- 검색 결과 0건·네트워크 끊김 → 카드가 '검색 중'에 멈추지 않고 '확인 필요'가 되며, 직접 입력해 저장할 수 있어야 한다 (Task 6 테스트 3·4번).
- v2로 이미 저장한 파일을 다시 열면 → 기존 가사·싱크 가사·정사각형 커버·`ANALYSIS`가 자동 값으로 덮이거나 저장 때 지워지면 안 된다 (Task 5 테스트 2·4·6번).
- 공유 시트가 떠 있는 동안 저장 버튼을 또 누르면 → 두 번째 `share` 호출이 오류를 내므로 공유 중에는 버튼을 막는다 (Task 7 Step 3).
- 검증(`verify`) 실패 → 저장을 막고 "저장을 막았어요(원본은 안전해요)"와 [진단 정보 복사]를 보여 준다 (Task 7 Step 3).

## Rulings (기획서와 다르게 정한 것)

- M2에서는 원본 바이트(`Uint8Array`)를 항목마다 메모리에 들고 있는다. 저장 탭 핸들러 안에서 `await` 없이 동기로 쓰기·검증을 끝내야 공유 권한(사용자 제스처)이 유지되기 때문이다. 기획서 5.8의 'File 참조만 들고 있기'는 M4(일괄 처리)에서 다시 본다.
- 검색어 후보는 [라틴 표기], [한글 우선 표기], [파일명 끝 숫자를 지우기 전 원문] 최대 3개로 한다. 기획서의 '정리한 전체'는 위 두 개와 중복이라 뺐다.
- 카드 삭제는 밀기 제스처 대신 ✕ 버튼으로 한다. [준비된 N곡 저장]과 자동 확정(준비 완료) 판정은 M4 범위다.
- 여러 파일을 한 번에 공유하는지 확인하는 일은 일괄 저장이 생기는 M4로 넘긴다.
- M0 측정 페이지는 지우지 않고 `m0.html`로 옮긴다. 다른 기기에서 메모리를 다시 잴 때 쓴다.

---

### Task 1: 앱 뼈대 (React · Tailwind · zustand · PWA · oxlint)

**Files:**
- Move: `index.html` → `m0.html`, `src/main.ts` → `src/m0.ts` (내용 그대로, `m0.html`의 script src만 `/src/m0.ts`로)
- Create: `index.html`, `src/main.tsx`, `src/App.tsx`, `src/index.css`, `public/icons/icon-180.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`
- Modify: `vite.config.ts`, `tsconfig.json`, `package.json`, `src/env.d.ts`(필요하면)

**Interfaces:**
- Produces: `src/App.tsx`의 `export default function App()` (Task 7이 내용을 채운다), `src/index.css`(Tailwind 진입점), `npm run lint`, `npm test`(= `node --test "src/**/*.test.ts"`)

- [ ] **Step 1: 의존성 설치**

```bash
npm install react@^19 react-dom@^19 zustand@^5
npm install -D @vitejs/plugin-react@^6 tailwindcss@^4 @tailwindcss/vite@^4 vite-plugin-pwa@^1 oxlint@^1 @types/react@^19 @types/react-dom@^19
```

- [ ] **Step 2: 아이콘 생성 (단색 정사각형, 나중에 교체 가능)**

```bash
mkdir -p public/icons
for s in 180 192 512; do ffmpeg -v error -y -f lavfi -i color=c=0x2563eb:s=${s}x${s} -frames:v 1 public/icons/icon-$s.png; done
```

- [ ] **Step 3: 설정 파일 작성**
  - `package.json` scripts: `"test": "node --test \"src/**/*.test.ts\""`, `"lint": "oxlint"`. 나머지 스크립트는 그대로.
  - `tsconfig.json`: `"jsx": "react-jsx"`를 추가하고, `types`에 `"vite/client"`를 추가한다.
  - `vite.config.ts`: 기존 `base`·`__BUILD_ID__`는 그대로 두고 아래를 추가한다.
    - `react()`, `tailwindcss()`
    - 다중 페이지 입력 `index.html`, `m0.html`
    - `VitePWA`:
      - `registerType: 'autoUpdate'`
      - manifest `{ name: 'M4A Tag Master', short_name: 'Tag Master', start_url: '.', scope: '.', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff' }`, 아이콘 192·512(512는 `purpose: 'maskable'` 항목도 하나 더)
      - `workbox: { globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'], maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, navigateFallback: '/m4a-tag-master-v2/index.html' }`. 분석 워커(약 2.55MB)도 사전 캐시에 들어가게 하려는 설정이다.
  - `index.html`:
    - `lang="ko"`, viewport `width=device-width, initial-scale=1.0, viewport-fit=cover`
    - `apple-touch-icon`=`/icons/icon-180.png`, `apple-mobile-web-app-capable`, 제목 `M4A Tag Master`
    - `<div id="root">`, `/src/main.tsx`
  - `src/index.css`: `@import "tailwindcss";`
  - `src/main.tsx`: `StrictMode`로 `App`을 렌더링한다.
  - `src/App.tsx`: 제목 "M4A Tag Master"와 하단 `빌드 {__BUILD_ID__}`만 표시한다.

- [ ] **Step 4: 검증**

Run: `npm run build && ls dist && grep -c "analyzer.worker" dist/sw.js && npm run lint && npm test`
Expected:
- 빌드가 오류 없이 끝나고, `dist`에 `index.html m0.html manifest.webmanifest sw.js`가 있다.
- `grep` 결과가 1 이상이다.
- oxlint 오류가 0이다.
- 기존 mp4 테스트 6개가 통과하고 1개는 skip된다.

- [ ] **Step 5: Commit** — `git add -A`는 쓰지 않는다. 위 파일만 이름을 적어 추가한 뒤 `git commit -m "M2 뼈대: React·Tailwind·zustand·PWA, M0 페이지는 m0.html로 이동"`

### Task 2: 검색어 정리 `parseSource` (기획서 5.2)

**Files:** Create: `src/lookup/query.ts`, `src/lookup/query.test.ts`

**Interfaces:**
- Produces:
  - `export interface ParsedSource { artist: string; title: string; queries: string[] }`
  - `export function parseSource(fileName: string, tags: { title?: string; artist?: string }): ParsedSource`
  - `export function normalizeName(s: string): string`: NFC → 소문자 → 공백과 구두점(`\p{P}`, `\p{S}`) 제거. Task 4가 가수 이름을 비교할 때 쓴다.

**규칙** (순서대로 적용)
1. 입력 문자열과 `tags`를 NFC로 정규화한다. 입력은 `tags.title`이 있으면 그것을, 없으면 확장자를 뗀 파일명을 쓴다.
2. 파일명을 입력으로 쓸 때만 적용하는 규칙:
   - 끝의 ` 숫자`(iOS 중복 접미, `/\s\d+$/`)를 떼어 둔다.
   - 앞쪽의 채널 접두를 지운다. `{tags.artist} - `와 일치하거나, 아래 목록의 채널명으로 시작하는 `{채널} - `이면 지운다. 목록: `1theK`(괄호 병기 포함), `Stone Music Entertainment`, `HYBE LABELS`, `SMTOWN`, `JYP Entertainment`, `YG ENTERTAINMENT`, `CJENMMUSIC`, `KBS Kpop`, `Mnet K-POP`.
3. 잡음을 지운다. 잡음 단어는 `MV`, `M/V`, `Official`, `Music Video`, `Video`, `Audio`, `Lyrics`, `Lyric`, `가사`, `4K`, `HD`이고, 대소문자를 가리지 않으며 단어 경계가 맞을 때만 해당한다.
   - 내용에 잡음 단어가 들어 있는 `[...]`, `(...)`, `【...】` 묶음을 통째로 지운다.
   - 따로 떨어진 잡음 단어를 지운다.
4. 가수와 제목을 나눈다.
   - 구분자 ` - `, ` _ `, ` | ` 중 처음 나오는 것을 기준으로 앞은 가수, 뒤는 제목이다.
   - 구분자가 없고 따옴표(`'…'`, `"…"`, `‘…’`, `“…”`) 구간이 있으면, 따옴표 앞은 가수이고 따옴표 안은 제목이다.
   - 둘 다 없으면 전체가 제목이고, 가수는 `tags.artist`(없으면 빈 문자열)다. 이때 `tags.artist`에도 5번 분리 규칙을 적용한다.
5. 각 부분을 라틴 표기와 한글 표기로 나눈다.
   - `X(Y)` 꼴이고 한쪽에만 한글이 있으면, 한글 쪽이 한글 표기, 다른 쪽이 라틴 표기다.
   - 가수 부분에 한해, 괄호가 없고 한글 토큰과 비한글 토큰이 섞여 있으면 토큰을 글자 종류별로 묶는다.
   - 나누지 못하면 원문에 한글이 있을 때 한글 표기로, 없을 때 라틴 표기로 본다.
6. 출력:
   - `artist`와 `title`은 각각 한글 표기 → 라틴 표기 순으로 있는 것을 쓴다.
   - `queries`는 [라틴 가수 + 라틴 제목(둘 다 라틴 표기가 있을 때. 가수가 비어 있으면 제목만)], [한글 우선 가수 + 한글 우선 제목], [2번에서 뗀 숫자를 붙인 원래 제목으로 만든 한글 우선 검색어]를 순서대로 모은 것이다.
   - 빈 값과 중복은 빼고 공백은 하나로 합친다. 최대 3개.

- [ ] **Step 1: 실패하는 테스트 작성** — `parseSource(fileName, tags)`의 결과 전체를 `deepEqual`로 비교한다.

| # | fileName | tags | artist | title | queries |
|---|---|---|---|---|---|
| 1 | `1theK (원더케이) - Lee Juck(이적) _ running on the sky(하늘을 달리다).m4a` | `{title:'Lee Juck(이적) _ running on the sky(하늘을 달리다)', artist:'1theK (원더케이)'}` | `이적` | `하늘을 달리다` | `['Lee Juck running on the sky','이적 하늘을 달리다']` |
| 2 | 1번과 같음 | `{}` | `이적` | `하늘을 달리다` | 1번과 같음 |
| 3 | `김동률 - 산책 2.m4a` | `{}` | `김동률` | `산책` | `['김동률 산책','김동률 산책 2']` |
| 4 | `aespa 에스파 'Whiplash' MV.m4a` | `{}` | `에스파` | `Whiplash` | `['aespa Whiplash','에스파 Whiplash']` |
| 5 | `'김동률 - 산책.m4a'.normalize('NFD')` | `{}` | `김동률`(NFC) | `산책`(NFC) | `['김동률 산책']` |
| 6 | `IU(아이유) - Love wins all [MV].m4a` | `{}` | `아이유` | `Love wins all` | `['IU Love wins all','아이유 Love wins all']` |
| 7 | `산책.m4a` | `{}` | `` | `산책` | `['산책']` |
| 8 | `4Kings - Thunder.m4a` | `{}` | `4Kings` | `Thunder` | `['4Kings Thunder']` |
| 9 | `이적 - 하늘을 달리다.m4a` | `{title:'하늘을 달리다', artist:'이적'}` | `이적` | `하늘을 달리다` | `['이적 하늘을 달리다']` |

추가로 `normalizeName(' Lee  Juck! ')`이 `'leejuck'`, `normalizeName('이 적')`이 `'이적'`인지 확인한다.

- [ ] **Step 2: 실패 확인** — Run: `node --test src/lookup/query.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `src/lookup/query.ts` 구현** — 위 규칙대로 쓴다. 정규식은 유니코드 플래그(`u`)를 쓰고, 한글 판정은 `/\p{Script=Hangul}/u`로 한다.
- [ ] **Step 4: 통과 확인** — Run: `node --test src/lookup/query.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "검색어 정리 parseSource (채널 접두·잡음·한글/라틴 분리)"`

### Task 3: 네트워크 도우미와 iTunes 검색 (기획서 5.3, 8.4)

**Files:** Create: `src/lookup/http.ts`, `src/lookup/itunes.ts`, `src/lookup/itunes.test.ts`, `src/testing.ts`

**Interfaces:**
- Produces (`src/lookup/http.ts`):
  - `export class LookupError extends Error {}` — 메시지는 화면에 그대로 보여 준다.
  - `export async function fetchJson(url: string): Promise<unknown | null>`
    - 8초 타임아웃(`AbortSignal.timeout(8000)`)을 건다.
    - 네트워크 오류나 타임아웃이면 1번 다시 시도하고, 그래도 실패하면 `LookupError('검색 실패 (네트워크)')`를 던진다.
    - 404면 `null`을 돌려준다.
    - 그 밖의 2xx가 아닌 응답이면 `LookupError(\`검색 실패 (${status})\`)`를 던진다.
    - 2xx 응답은 URL별로 세션 동안 캐시한다.
  - `export async function fetchBytes(url: string): Promise<Uint8Array>`: 타임아웃·재시도·오류 규칙은 같고, 캐시하지 않는다.
  - `export function limiter(max: number, windowMs: number): () => Promise<void>`: 최근 `windowMs` 안에 `max`번 통과했으면, 가장 오래된 통과가 창 밖으로 나갈 때까지 기다린다.
- Produces (`src/lookup/itunes.ts`):
  - `export interface Candidate { trackId: number; title: string; artist: string; album: string; durationSec: number; artworkUrl: string }` — `artworkUrl`은 1000px 주소이고, 없으면 `''`이다.
  - `export function parseItunes(json: unknown): Candidate[]`: 응답 순서를 유지하고 `trackId`로 중복을 없앤다. `trackId`나 `trackName`이 없는 결과는 버린다. `durationSec = trackTimeMillis / 1000`.
  - `export async function searchItunes(queries: string[]): Promise<{ query: string; candidates: Candidate[] }>`
    - 검색어를 순서대로 시도하고, 결과가 나오면 거기서 멈춘다. 모두 0건이면 `{ query: queries[0] ?? '', candidates: [] }`를 돌려준다.
    - 요청마다 모듈 수준의 `limiter(20, 60_000)`을 거친다.
- Produces (`src/testing.ts`, 테스트 전용):
  - `export function stubFetch(t: import('node:test').TestContext, handler: (url: URL) => Response | Promise<Response>): string[]` — `globalThis.fetch`를 `t.mock.method`로 바꾸고, 요청된 URL 배열을 돌려준다.

- [ ] **Step 1: 실패하는 테스트 작성** (`itunes.test.ts`)
  1. `parseItunes`: 아래 응답을 넣으면 후보 2개가 나온다. `{trackId:1,title:'Running on the Sky',artist:'Lee Juck',album:'2적',durationSec:263,artworkUrl:'https://is1-ssl.mzstatic.com/image/thumb/a/1000x1000bb.jpg'}`와 `trackId 2`, 이 순서다.
     - 응답: `{resultCount:4, results:[{trackId:1,artistName:'Lee Juck',trackName:'Running on the Sky',collectionName:'2적',trackTimeMillis:263000,artworkUrl100:'https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg'}, (trackId 1 중복), {trackId:2,artistName:'Lee Juck',trackName:'Run Across the Sky',collectionName:'Do You Remember',trackTimeMillis:265000}, {artistName:'x'}]}`
     - `trackId 2`는 `artworkUrl:''`이다.
  2. `searchItunes(['없는곡','Lee Juck running on the sky'])`:
     - 첫 검색어는 `{resultCount:0,results:[]}`, 둘째는 1번 응답을 돌려주도록 stub한다.
     - `query`가 둘째 검색어이고 후보가 2개다.
     - 요청 URL 2개가 모두 `entity=song`, `limit=10`, `country=US`, `term=`(인코딩된 검색어)를 담고 있다.
  3. `fetchJson`:
     - 같은 URL을 두 번 부르면 fetch는 1번만 불린다.
     - 404면 `null`을 돌려준다.
     - 503이면 `LookupError`이고 메시지가 `검색 실패 (503)`이다.
     - fetch가 처음 한 번 reject하면 재시도해서 성공한다.
     - 두 번 다 reject하면 `LookupError('검색 실패 (네트워크)')`이다.
  4. `limiter(2, 1000)`: `t.mock.timers`로 시간을 제어한다. 세 번째 통과는 1000ms가 지나기 전에는 resolve되지 않고, 지난 뒤에 resolve된다.

- [ ] **Step 2: 실패 확인** — Run: `node --test src/lookup/itunes.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `http.ts`, `itunes.ts`, `testing.ts` 구현**
- [ ] **Step 4: 통과 확인** — Run: `node --test src/lookup/itunes.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "네트워크 도우미(타임아웃·재시도·캐시·리미터)와 iTunes 검색"`

### Task 4: 가사 (LRC 처리 + LRCLIB 검색·채택) (기획서 5.4)

**Files:** Create: `src/lookup/lyrics.ts`, `src/lookup/lyrics.test.ts`

**Interfaces:**
- Consumes:
  - `fetchJson`, `LookupError` (Task 3)
  - `Candidate` (Task 3)
  - `normalizeName` (Task 2)
  - `stubFetch` (Task 3)
- Produces:
  - `export interface LyricsCandidate { id: number; artist: string; title: string; album: string; durationSec: number; plain?: string; synced?: string }`
  - `export function isLrc(text: string): boolean`: 비어 있지 않은 줄의 절반 이상이 시간 태그 `/^\[\d+:\d{2}(\.\d+)?\]/`로 시작하면 참이다.
  - `export function stripLrc(lrc: string): string`
    - 줄 앞의 시간 태그를 모두 지운다. 한 줄에 여러 개가 연달아 있어도 모두 지운다.
    - ID 태그 줄(`/^\[[a-z]+:.*\]$/i`, 예: `[ar:…]` `[offset:…]`)은 버린다.
    - 각 줄 끝 공백을 지우고, 전체 앞뒤 공백도 지운다.
  - `export function splitLyrics(text: string): { lyrics: string; lrc?: string }`: 붙여넣기용이다. LRC면 `{ lyrics: stripLrc(text), lrc: text.trim() }`, 아니면 `{ lyrics: text.trim() }`.
  - `export function candidateLyrics(c: LyricsCandidate): { lyrics: string; lrc?: string }`: `lyrics`는 `c.plain`이 있으면 그것, 없으면 `stripLrc(c.synced)`다. `lrc`는 `c.synced`다.
  - `export function pickLyrics(cands: LyricsCandidate[], artistNames: string[], refDurationSec: number): LyricsCandidate | undefined`
    - 아래 세 조건을 모두 만족하는 첫 후보를 돌려준다.
    - `normalizeName(c.artist)`가 `artistNames` 중 하나의 정규화 값과 같다.
    - `|c.durationSec − refDurationSec| ≤ 3`이다.
    - `plain`이나 `synced`가 있다.
  - `export interface LyricsQuery { title: string; artist: string; itunes?: Candidate; fileDurationSec: number }`
  - `export async function findLyrics(q: LyricsQuery): Promise<{ adopted?: LyricsCandidate; candidates: LyricsCandidate[] }>`
    - 아래 순서로 요청한다. 요청할 때마다 결과를 `candidates`에 합치고(`id`로 중복 제거), `pickLyrics`로 채택할 것이 생기면 바로 멈춘다.
      1. `itunes`가 있을 때만: `https://lrclib.net/api/get?track_name=&artist_name=&album_name=&duration=`. 값은 iTunes의 제목·가수·앨범이고, `duration`은 `Math.round(itunes.durationSec)`다. 응답은 객체 하나이고, 404면 결과가 없는 것이다.
      2. `https://lrclib.net/api/search?track_name={title}&artist_name={artist}`. 이어서 `itunes`가 있고 제목·가수 쌍이 다르면 같은 요청을 iTunes 제목·가수로 한 번 더 한다.
      3. `https://lrclib.net/api/search?q={artist} {title}`
    - `artistNames = [q.artist, q.itunes?.artist]`에서 빈 값을 뺀 것이다.
    - `refDurationSec`는 `q.itunes?.durationSec`이고, 없으면 `q.fileDurationSec`이다.
    - LRCLIB 필드는 `id, trackName, artistName, albumName, duration, plainLyrics, syncedLyrics`이고, `null`인 가사 필드는 없는 것으로 본다.

- [ ] **Step 1: 실패하는 테스트 작성** (`lyrics.test.ts`)
  1. `isLrc('[00:01.00]a\n[00:02.50]b')`는 참이다. `isLrc('그냥 가사\n[00:01.00]a\nb')`는 거짓이다.
  2. `stripLrc('[ar:이적]\n[00:01.00][00:30.00]두근거렸지 \n[00:05.00]\n[00:06.00]누군가')`는 `'두근거렸지\n\n누군가'`다.
  3. `splitLyrics('[00:01.00]가사')`는 `{lyrics:'가사', lrc:'[00:01.00]가사'}`다. `splitLyrics(' 가사 ')`는 `{lyrics:'가사'}`다.
  4. `candidateLyrics`:
     - plain과 synced가 둘 다 있으면 plain을 쓰고, `lrc`는 synced다.
     - synced만 있으면 `lyrics`는 타임스탬프를 지운 텍스트다.
  5. `pickLyrics`: 아래 후보와 `artistNames ['이적','Lee Juck']`, `ref 263`이면 id 3을 고른다.
     - `{id:1, artist:'소향', duration 255, plain}` (커버곡이라 제외)
     - `{id:2, artist:'이적', duration 297, plain}` (길이 차이가 커서 제외)
     - `{id:3, artist:'Lee Juck', duration 262, synced}`
  6. `findLyrics({title:'하늘을 달리다', artist:'이적', itunes:{…Running on the Sky, Lee Juck, 2적, 263}, fileDurationSec:297})`:
     - stub: get은 404, 첫 search는 `[]`, 둘째 search(iTunes 이름)는 id 3에 해당하는 응답을 돌려준다.
     - `adopted.id === 3`이다.
     - 요청 URL이 순서대로 get, search(`track_name=하늘을 달리다`), search(`track_name=Running on the Sky`)이고, `q=` 요청은 하지 않는다.
     - get URL은 `duration=263`과 `album_name=2적`(인코딩된 값)을 담는다.
  7. `findLyrics`에 `itunes`가 없으면 get을 부르지 않고, 기준 길이는 `fileDurationSec`을 쓴다.

- [ ] **Step 2: 실패 확인** — Run: `node --test src/lookup/lyrics.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `src/lookup/lyrics.ts` 구현**
- [ ] **Step 4: 통과 확인** — Run: `node --test src/lookup/lyrics.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "가사: LRC 처리와 LRCLIB 검색·채택"`

### Task 5: 편집 모델, 출력 파일, 이미지 크기 (기획서 5.3 표기 정책, 5.6 9번)

**Files:** Create: `src/edit.ts`, `src/edit.test.ts`, `src/save.ts`, `src/cover.ts`. Modify: `src/testing.ts`

**Interfaces:**
- Consumes:
  - `Tags`, `writeTags`, `verify`, `readTags` (`src/mp4.ts`)
  - `ParsedSource` (Task 2)
  - `Candidate` (Task 3)
  - `LyricsCandidate`, `candidateLyrics` (Task 4)
- Produces (`src/cover.ts`):
  - `export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined`: PNG는 IHDR, JPEG는 SOF0~SOF15 마커(DHT `C4`, JPG `C8`, DAC `CC` 제외)에서 읽는다. 그 밖의 형식이면 `undefined`.
  - `export function isSquare(bytes: Uint8Array): boolean`
- Produces (`src/edit.ts`):
  - `export interface Source { fileName: string; bytes: Uint8Array; duration: number; tags: Tags }`
  - `export interface Edit`
    - `query: string`
    - `candidates: Candidate[]`, `candidate?: Candidate`
    - `title: string`, `artist: string`, `album: string`
    - `lyrics: string`, `lrc?: string`, `lyricsManual: boolean`
    - `lyricsCandidates: LyricsCandidate[]`
    - `cover?: Uint8Array`
  - `export function initialEdit(src: Source, parsed: ParsedSource): Edit`
    - `title`과 `artist`는 `parsed`에서 가져온다.
    - `album`은 `src.tags.album`이다. 단, `src.tags.artist`와 같으면 유튜브 채널명이 남은 것이므로 `''`로 한다.
    - `lyrics`는 `src.tags.lyrics ?? ''`, `lrc`는 `src.tags.lrc`다.
    - `lyricsManual`은 기존 가사나 LRC가 있으면 `true`다.
    - `cover`는 `src.tags.cover`, `query`는 `parsed.queries[0] ?? ''`다.
    - 후보 목록은 빈 배열로 둔다.
  - `export function selectCandidate(e: Edit, src: Source, c: Candidate, artwork?: Uint8Array): Edit`
    - `candidate`는 `c`, `album`은 `c.album`이다.
    - `cover`는 기존 커버가 정사각형이면 기존 커버, 아니면 `artwork ?? src.tags.cover`다.
  - `export function applyLyrics(e: Edit, r: { adopted?: LyricsCandidate; candidates: LyricsCandidate[] }): Edit`
    - `lyricsCandidates`는 항상 갱신한다.
    - `!e.lyricsManual`이고 `adopted`가 있을 때만 `candidateLyrics`로 `lyrics`와 `lrc`를 채운다.
  - `export function toTags(e: Edit, src: Source): Tags`: `{ title, artist, album, lyrics, lrc, cover, analysis: src.tags.analysis }`. 기존 분석값은 M3 전까지 보존한다.
  - `export function outputName(e: Edit, originalName: string): string`: Global Constraints의 파일명 규칙을 따른다. 가수가 비어 있으면 `{제목}.m4a`, 제목도 비어 있으면 원래 파일명(같은 정리 규칙 적용)을 쓴다.
  - `export function formatDiff(sec: number): string`: 반올림한 정수에 부호를 붙이고 `초`를 붙인다. 음수는 유니코드 마이너스 `−`를 쓰고, 0은 `0초`다.
- Produces (`src/save.ts`):
  - `export function buildOutput(src: Source, e: Edit): File`: `writeTags(src.bytes, toTags(e, src))`로 쓰고 `verify`를 통과한 뒤 `new File([out], outputName(e, src.fileName), { type: 'audio/mp4' })`를 돌려준다. 검증에 실패하면 `verify`가 던진 오류를 그대로 던진다.
  - `export async function shareOrDownload(file: File): Promise<'shared' | 'downloaded' | 'cancelled'>`: 브라우저 전용이라 이 Task에서는 테스트하지 않는다. Global Constraints의 저장 규칙을 따르고, `NotAllowedError`는 그대로 던진다.
- Produces (`src/testing.ts`에 추가):
  - `export function ffmpeg(...args: string[]): Buffer`: 오류가 나거나 stderr가 비어 있지 않으면 실패한다.
  - `export function makeM4a(...args: string[]): Uint8Array`: 3초 사인파에 `args`를 추가 옵션으로 붙인다.
  - `export function makeImage(width: number, height: number, format: 'mjpeg' | 'png'): Uint8Array`

- [ ] **Step 1: 실패하는 테스트 작성** (`edit.test.ts`)
  1. `imageSize`:
     - `makeImage(1280,720,'mjpeg')`는 `{width:1280,height:720}`이다.
     - `makeImage(32,32,'png')`는 `{32,32}`이다.
     - 아무 바이트 100개는 `undefined`다.
     - `isSquare`는 1280×720 이미지에서 거짓, 32×32 이미지에서 참이다.
  2. `initialEdit` (yt-dlp 형태):
     - 입력: tags `{title:'Lee Juck(이적) _ running on the sky(하늘을 달리다)', artist:'1theK (원더케이)', album:'1theK (원더케이)', cover:1280×720}`, parsed `{artist:'이적', title:'하늘을 달리다', queries:['Lee Juck running on the sky','이적 하늘을 달리다']}`
     - 결과: `album ''`, `lyrics ''`, `lyricsManual false`, `query 'Lee Juck running on the sky'`, `cover`는 기존 커버
  3. `selectCandidate`:
     - 기존 커버가 1280×720이고 artwork가 32×32 PNG면 `cover`는 artwork, `album`은 `'2적'`이다.
     - 기존 커버가 32×32면 `cover`는 기존 커버다.
  4. `initialEdit` (v2 출력 형태):
     - 입력: tags `{title:'하늘을 달리다', artist:'이적', album:'2적', lyrics:'가사', lrc:'[00:01.00]가사', analysis:'{"version":1}'}`
     - 결과: `album '2적'`, `lyricsManual true`. 이어서 `applyLyrics`에 `adopted`를 넣어도 `lyrics`는 `'가사'` 그대로다.
  5. `applyLyrics`: `lyricsManual false`면 `adopted`의 plain과 synced가 `lyrics`·`lrc`에 들어간다.
  6. `toTags`: 4번 입력에서 `analysis`가 `'{"version":1}'`로 남는다.
  7. `outputName`:
     - (`이적`, `하늘을 달리다`) → `이적 - 하늘을 달리다.m4a`
     - (``, `산책`) → `산책.m4a`
     - (``, ``, 원래 이름 `김동률 - 산책 2.m4a`) → `김동률 - 산책 2.m4a`
     - (`AC/DC`, `What? "Now"`) → `ACDC - What Now.m4a`
     - NFD 입력이면 결과가 NFC다.
     - 제목이 200자면 확장자를 뺀 길이가 120이다.
  8. `formatDiff`: `-34.2` → `−34초`, `3` → `+3초`, `0.4` → `0초`
  9. `buildOutput`:
     - 입력: `makeM4a('-metadata','title=x','-movflags','+faststart')`와 2번 결과에 `title:'하늘을 달리다'`, `artist:'이적'`, `cover:` 32×32 PNG를 넣은 Edit
     - 결과: `file.name`은 `이적 - 하늘을 달리다.m4a`, `file.type`은 `audio/mp4`다. `readTags(new Uint8Array(await file.arrayBuffer()))`가 `toTags` 결과와 같다(빈 필드는 없는 것으로 본다).

- [ ] **Step 2: 실패 확인** — Run: `node --test src/edit.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `cover.ts`(`imageSize`, `isSquare`), `edit.ts`, `save.ts`, `testing.ts` 추가분 구현**
- [ ] **Step 4: 통과 확인** — Run: `npm test` / Expected: 모든 테스트 PASS (mp4의 실제 파일 테스트만 skip)
- [ ] **Step 5: Commit** — `git commit -m "편집 모델·출력 파일 이름·이미지 크기"`

### Task 6: 큐 스토어와 자동 조회 (기획서 3장 S1, 5.1, 9장)

**Files:** Create: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes:
  - `inspect`, `readTags`, `Mp4Error` (mp4)
  - `parseSource` (Task 2)
  - `searchItunes`, `Candidate`, `fetchBytes`, `LookupError` (Task 3)
  - `findLyrics` (Task 4)
  - `Source`, `Edit`, `initialEdit`, `selectCandidate`, `applyLyrics` (Task 5)
  - `stubFetch`, `makeM4a`, `makeImage` (testing)
- Produces:
  - `export type Status = 'reading' | 'searching' | 'review' | 'saved' | 'failed'`
  - `export const STATUS_LABEL: Record<Status, string> = { reading: '읽는 중', searching: '검색 중', review: '확인 필요', saved: '저장됨', failed: '실패' }`
  - `export interface Item { id: string; fileName: string; status: Status; error?: string; source?: Source; parsed?: ParsedSource; edit?: Edit; savedAs?: string }`. `parsed`는 `lookup`의 기본 검색어와 화면의 [원본] 값에 쓴다.
  - `export const useQueue` (zustand `create`)는 아래 상태와 액션을 가진다.
    - `items: Item[]`
    - `addFiles(files: File[]): { ids: string[]; done: Promise<void> }`
      - 상태 `'reading'`인 항목을 즉시 추가하고 id를 돌려준다.
      - 이어서 파일마다 순서대로 처리한다. 바이트를 읽고 `inspect`, `readTags`, `parseSource`, `initialEdit`를 거친 뒤 `'searching'`으로 바꾸고 `lookup`을 부른다.
      - `Mp4Error`가 나면 `'failed'`로 바꾸고 `error`에 그 메시지를 넣는다.
    - `lookup(id: string, query?: string): Promise<void>`
      - `searchItunes(query ? [query] : parsed.queries)`를 부른다. 이때 `edit.query`는 실제로 결과를 낸 검색어로 바꾼다.
      - 첫 후보가 있으면 `fetchBytes(artworkUrl)`로 커버를 받아(실패하면 커버 없이 진행) `selectCandidate`를 적용한다.
      - 이어서 `findLyrics`를 부르고 `applyLyrics`를 적용한다.
      - 끝나면 `'review'`로 바꾼다.
      - 어떤 오류가 나도 `'review'`로 끝낸다. `error`에는 `LookupError`면 그 메시지를, 아니면 `'검색 중 오류가 났어요'`를 넣는다.
      - 함수를 시작할 때 `error`를 지운다.
    - `choose(id: string, c: Candidate): Promise<void>`: 커버를 받아 `selectCandidate`를 적용한다. `lyricsManual`이 아니면 가사를 다시 찾는다.
    - `update(id: string, patch: Partial<Edit>): void`
    - `remove(id: string): void`
    - `markSaved(id: string, savedAs: string): void`

- [ ] **Step 1: 실패하는 테스트 작성** (`store.test.ts`). 테스트마다 시작할 때 `useQueue.setState({ items: [] })`로 비운다. 테스트끼리 HTTP 캐시가 겹치지 않도록 검색어와 응답을 테스트마다 다르게 한다.
  1. **yt-dlp 형태 한 곡**
     - 파일: `makeM4a('-metadata','title=Lee Juck(이적) _ running on the sky(하늘을 달리다)','-metadata','artist=1theK (원더케이)','-metadata','album=1theK (원더케이)','-movflags','+faststart')`를 이름 `1theK (원더케이) - Lee Juck(이적) _ running on the sky(하늘을 달리다).m4a`인 `File`로 만든다.
     - stub:
       - iTunes는 Task 3 테스트 1번 응답을 돌려준다.
       - artwork URL은 32×32 PNG를 돌려준다.
       - LRCLIB get은 404를 돌려준다.
       - search는 `[{id:7,artistName:'이적',trackName:'하늘을 달리다',albumName:'2적',duration:263,plainLyrics:'두근거렸지',syncedLyrics:'[00:01.00]두근거렸지'}]`를 돌려준다.
     - `await done` 후 확인할 것:
       - `status 'review'`, `edit.title '하늘을 달리다'`, `artist '이적'`, `album '2적'`
       - `cover`가 PNG 바이트와 같다.
       - `lyrics '두근거렸지'`, `lrc '[00:01.00]두근거렸지'`, `error`는 없다.
       - 첫 요청 URL의 `term`이 `Lee Juck running on the sky`다.
  2. **m4a가 아닌 파일:** `new File([new Uint8Array(1000).fill(7)], 'x.m4a')`는 `status 'failed'`이고 `error`가 `/손상/`과 맞는다.
  3. **검색 결과 0건:** iTunes가 모든 검색어에 0건, LRCLIB search가 `[]`를 돌려주면 `status 'review'`, `candidate` 없음, `edit.title`은 parse 결과다.
  4. **네트워크 끊김:** fetch가 항상 reject하면 `status 'review'`이고 `error`가 `'검색 실패 (네트워크)'`다.
  5. **`lookup(id, '수정한 검색어')`:** iTunes 요청이 `term=수정한 검색어` 하나뿐이고, `edit.query`가 `'수정한 검색어'`다.
  6. **`choose(id, 다른 후보)`:** `album`이 그 후보의 앨범으로 바뀐다. `update(id, { lyricsManual: true })`를 한 뒤 `choose`를 부르면 LRCLIB 요청이 더 나가지 않는다.

- [ ] **Step 2: 실패 확인** — Run: `node --test src/store.test.ts` / Expected: FAIL (모듈 없음)
- [ ] **Step 3: `src/store.ts` 구현** — id는 `crypto.randomUUID()`로 만든다.
- [ ] **Step 4: 통과 확인** — Run: `npm test` / Expected: 모든 테스트 PASS
- [ ] **Step 5: Commit** — `git commit -m "큐 스토어: 파일 읽기·자동 조회·후보 선택"`

### Task 7: 화면 A~D, 저장, 스모크 테스트 (기획서 6장, 5.7, 9장)

**Files:**
- Create: `src/ui/QueueScreen.tsx`, `src/ui/EditScreen.tsx`, `src/ui/CandidateSheet.tsx`, `src/ui/LyricsSheet.tsx`, `scripts/e2e.ts`
- Modify: `src/App.tsx`, `src/cover.ts`(자르기 추가), `package.json`, `README.md`

**Interfaces:**
- Consumes: `useQueue`, `Item`, `STATUS_LABEL` (Task 6), `buildOutput`, `shareOrDownload` (Task 5), `formatDiff`, `Edit` (Task 5), `splitLyrics`, `candidateLyrics` (Task 4), `isSquare` (Task 5)
- Produces:
  - `export async function cropSquareJpeg(bytes: Uint8Array): Promise<Uint8Array>` (`src/cover.ts`): `createImageBitmap`으로 연 뒤 가운데를 짧은 변 길이의 정사각형으로 잘라 canvas에 그리고, JPEG 품질 0.92로 만든다. 크기는 원본 해상도 그대로다.
  - `npm run test:e2e`

- [ ] **Step 1: 스모크 테스트 작성** (`scripts/e2e.ts`, `playwright-core`를 dev 의존성으로 추가)
  1. `npm run build`가 끝난 상태를 전제로 `vite preview --port 4174 --strictPort`를 띄운다. 끝나면 종료한다.
  2. 브라우저: `chromium.launch({ channel: 'chrome', headless: true })`
  3. 저장 경로를 다운로드로 고정한다: `page.addInitScript`로 `Navigator.prototype.share`와 `Navigator.prototype.canShare`를 지운다.
  4. `page.route`로 외부 요청을 고정한다.
     - `itunes.apple.com`은 Task 3 테스트 1번 응답을 돌려준다.
     - `mzstatic.com`은 `makeImage(32,32,'mjpeg')`를 돌려준다.
     - `lrclib.net/api/get`은 404를 돌려준다.
     - `lrclib.net/api/search`는 Task 6 테스트 1번 응답을 돌려준다.
  5. Task 6 테스트 1번과 같은 m4a를 같은 이름으로 임시 파일에 쓰고 `setInputFiles`로 넣는다. 한 곡이므로 B 화면으로 바로 이동해야 한다.
  6. 확인할 것:
     - 제목 입력값 `하늘을 달리다`, 가수 `이적`, 앨범 `2적`
     - 후보 행에 `Running on the Sky`와 `−34초`가 보인다.
     - 가사 행에 일반 가사와 싱크 가사가 모두 있다고 표시된다.
  7. [저장 · 공유]를 누른다.
     - `page.waitForEvent('download')`로 받은 파일 이름이 `이적 - 하늘을 달리다.m4a`다.
     - 그 파일을 `readTags`로 읽었을 때 title·artist·album·lyrics·lrc가 위 값과 같고, cover가 JPEG 바이트와 같다.
  8. 뒤로 가기 후 카드 상태가 `저장됨`이다.
  9. 콘솔 오류(`console.error`, `pageerror`)가 0건이다.
  - `package.json`: `"test:e2e": "npm run build && node scripts/e2e.ts"`. CI에는 넣지 않는다.

- [ ] **Step 2: 실패 확인** — Run: `npm run test:e2e` / Expected: FAIL (B 화면 요소가 없음)
- [ ] **Step 3: 화면 구현** (기획서 6.1·6.2 와이어프레임에서 분석 영역을 뺀 것)
  - `App.tsx`: `selectedId` 상태를 둔다. 값이 있으면 `EditScreen`, 없으면 `QueueScreen`을 보여 준다. 라우터는 쓰지 않는다.
  - **A `QueueScreen`**
    - [＋ 파일 추가](Global Constraints의 input)를 둔다. 한 곡을 넣으면 그 id로 바로 B 화면으로 간다. 여러 곡이면 A 화면에 남는다.
    - 카드에는 커버 썸네일(`edit.cover`의 object URL, 다 쓰면 revoke), 제목, `가수 · 앨범`, `STATUS_LABEL`, 실패 사유를 보여 준다. ✕ 버튼을 누르면 `remove`한다.
    - 하단에 `빌드 {__BUILD_ID__}`를 표시한다.
  - **B `EditScreen`**
    - ‹ 큐, 상태 표시
    - 커버: 버튼 [iTunes 커버](후보의 artwork가 있을 때), [기존 커버](기존 커버가 있을 때), [정사각형으로 자르기](기존 커버가 있고 `!isSquare`일 때 `cropSquareJpeg`)
    - 검색어 입력 + 🔍 → `lookup(id, query)`
    - 후보 행: 제목, `가수 · 앨범 · formatDiff(candidate.durationSec − source.duration)`. 누르면 C 시트를 연다.
    - 제목·가수 입력과 [원본|iTunes] 버튼. 원본은 `item.parsed`의 값이고, iTunes는 선택된 후보의 값이다. 버튼은 입력값을 그 값으로 바꾼다.
    - [가수⇄제목] 버튼은 두 입력값을 서로 바꾼다. 순서가 반대인 채널을 위한 것이다(기획서 5.2 5번).
    - 앨범 입력
    - 가사 행: `일반 ✓/없음 · 싱크 ✓/없음`. 누르면 D 시트를 연다.
    - `error`가 있으면 그 메시지와 [다시 시도](`lookup(id)`)를 보여 준다.
    - 하단 [저장 · 공유]
  - **저장 핸들러** (클릭 핸들러 안에서 처리)
    - `await` 없이 `buildOutput`을 호출한다. 결과는 편집값 키(JSON)와 함께 ref에 캐시하고, 키가 같으면 다시 만들지 않는다.
    - 검증에 실패하면 저장하지 않고 "저장을 막았어요(원본은 안전해요)"와 [진단 정보 복사](오류 메시지를 클립보드로)를 보여 준다.
    - 그다음 `shareOrDownload`를 부른다. 공유가 진행되는 동안 버튼을 비활성화한다.
    - 결과가 `'shared'`나 `'downloaded'`면 `markSaved`를 부른다.
    - `NotAllowedError`면 "저장 버튼을 한 번 더 눌러 주세요"를 보여 주고, 캐시를 유지한다.
  - **C `CandidateSheet`**
    - 아래에서 올라오는 시트다.
    - 후보마다 썸네일(`artworkUrl`의 `1000x1000bb`를 `100x100bb`로 바꾼 주소), 제목, 가수, 앨범, 길이 차이를 보여 준다.
    - 후보를 누르면 `choose` 후 시트를 닫는다.
  - **D `LyricsSheet`**
    - `lyricsCandidates` 목록을 보여 준다. 채택된 것에는 ✓, 나머지에는 '다른 버전/커버'를 표시한다.
    - 후보를 누르면 `candidateLyrics`로 채우고 `lyricsManual: true`로 한다.
    - 붙여넣기 textarea와 [적용](`splitLyrics` 후 `lyricsManual: true`), [지우기](`lyrics ''`, `lrc undefined`, `lyricsManual: true`)를 둔다.
  - 스타일은 Tailwind로 하고, Global Constraints의 16px·44px·safe-area 규칙을 지킨다.
  - `README.md`의 '현재 상태'를 M2 설명으로 바꾸고, `npm test`와 `npm run test:e2e` 사용법을 적는다.
- [ ] **Step 4: 통과 확인** — Run: `npm run test:e2e && npm test && npm run lint` / Expected: 스모크 PASS, 단위 테스트 전부 PASS, oxlint 오류 0
- [ ] **Step 5: Commit** — `git commit -m "화면 A~D와 저장·공유, Playwright 스모크"`

---

## 완료 후 (사용자 실기기 확인, 계획 밖)

배포 후 아이폰에서 기획서 11.3 체크리스트 중 M2 해당 항목을 확인한다: S1 끝까지, 저장 파일 재생·커버, 홈 화면 PWA 모드, 빌드 버전.
