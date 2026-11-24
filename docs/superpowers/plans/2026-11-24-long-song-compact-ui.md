# 긴 곡 바로 저장 · 빌드 번호 위치 · 편집 화면 한 화면에 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (인라인). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 15분 넘는 곡은 검색 없이 무작위 커버를 받아 바로 '저장 필요'로, 큐의 빌드 표시는 화면 맨 아래로, 편집 화면은 구분선과 좁은 간격으로 한 화면에.

**Architecture:** 스토어 `load`가 긴 곡이면 `lookup` 대신 새 액션 `shuffleCover`를 부른다(lookup과 같은 요청 번호·'검색 중' 잠금). 화면은 Tailwind 클래스만 바꾼다.

**Tech Stack:** TypeScript, React 19, zustand, Tailwind v4, node:test, Playwright

**Spec:** `docs/superpowers/specs/2026-11-24-long-song-compact-ui-design.md`

## Global Constraints

- 긴 곡 기준: `source.duration > MAX_ANALYSIS_SEC` (15·60초, `src/runAnalysis.ts`).
- 무작위 커버 URL: `https://picsum.photos/1000?random=<난수>` — 곡 정보를 싣지 않는다.
- 터치 영역 44pt(`min-h-11`), 입력 글꼴 16px(`text-base`) 유지(기획서 6.3).
- 주석·문구 한국어. `git add`는 파일 이름으로.

## Review Focus

- 무작위 사진 받기가 실패(네트워크 끊김) → 커버는 원래대로, 오류 없이 '분석 건너뜀, 저장 필요' → Task 1 테스트 '긴 곡: 사진을 못 받아도 저장 필요'.
- 사진을 받는 사이 사용자가 직접 검색 → 늦게 온 사진이 검색 결과 커버를 덮지 않음(begin 공유) → Task 1 테스트 '긴 곡: 받는 사이 검색하면 사진은 버린다'.
- 파일에 분석이 이미 있는 긴 곡 → 분석은 'done' 유지, 검색만 건너뜀 → 기존 initialJob 테스트가 덮음, 새 테스트 없음.
- [다른 이미지]를 연달아 누름 → 마지막 것만 반영(begin) — 위 테스트와 같은 장치, 별도 테스트 없음.

---

### Task 1: 긴 곡은 검색 대신 무작위 커버

**Files:** Modify `src/store.ts`; Test `src/store.test.ts`

**Interfaces (Produces):** Queue 액션 `shuffleCover(id: string): Promise<void>`; `export const RANDOM_COVER_URL = 'https://picsum.photos/1000'`(테스트가 호스트를 맞춘다).

- [ ] **Step 1: 실패하는 테스트** (store.test.ts, 긴 곡 픽스처 `m4a('long.m4a', '-af', 'apad', '-t', '901', '-b:a', '16k')`; fetch stub은 picsum.photos·fastly.picsum.photos → PNG, 그 밖 → 실패 처리)
  - `긴 곡: 검색 없이 무작위 커버를 받고 바로 저장 필요` — status 'review', edit.cover = PNG, analysisJob.state 'skipped', 요청 URL이 모두 picsum.photos이고 `random=` 포함
  - `긴 곡: 사진을 못 받아도 저장 필요` — picsum 500 → status 'review', error 없음, cover는 원본(undefined)
  - `긴 곡: 받는 사이 검색하면 사진은 버린다` — picsum 응답을 늦추고 그 사이 `lookup(id, '검색어')` → cover는 iTunes 아트워크
  - `shuffleCover: 누를 때마다 다른 URL로 새 사진`
- [ ] **Step 2:** `node --test src/store.test.ts` → FAIL
- [ ] **Step 3:** 구현 — `load`에서 `duration > MAX_ANALYSIS_SEC`이면 `get().shuffleCover(id)`, 아니면 `lookup`. `shuffleCover`는 begin → 'searching' → `fetchBytes(\`${RANDOM_COVER_URL}?random=${난수}\`).catch(() => undefined)` → current면 cover patchEdit → 'searching'이면 'review'.
- [ ] **Step 4:** `npm test && npx tsc --noEmit && npm run lint` → 통과
- [ ] **Step 5:** 커밋 `git add src/store.ts src/store.test.ts`

### Task 2: 빌드 표시 맨 아래, 편집 화면 한 화면에, [다른 이미지]

**Files:** Modify `src/App.tsx`, `src/ui/QueueScreen.tsx`, `src/ui/EditScreen.tsx`, `src/ui/AnalysisCard.tsx`, `scripts/e2e.ts`(바뀐 글자)

**Interfaces (Consumes):** Task 1 `shuffleCover`, `MAX_ANALYSIS_SEC`.

- [ ] **Step 1:** App 바깥 상자 `flex flex-col`, QueueScreen main `flex flex-1 flex-col`, 빌드 표시 `mt-auto`.
- [ ] **Step 2:** EditScreen — 묶음 4개(커버·검색·후보 / 제목·가수·앨범+[가수⇄제목] / 가사 한 줄 / 분석) `divide-y`, 묶음 안 `space-y-2 py-2`, 커버 `size-24` 왼쪽·버튼 오른쪽, 긴 곡이면 [다른 이미지]. AnalysisCard — 테두리 상자 없앰, 제목 줄 `분석 (참고용)` + BPM 입력·×2·÷2(따로 있던 'BPM 값' 글자 없앰), 조성 줄 끝 [다시 분석], 주요 진행 `text-sm`.
- [ ] **Step 3:** e2e의 `getByText(/^BPM \d/)`를 BPM 입력란 값 대기로 바꾼다.
- [ ] **Step 4:** `npm test && npx tsc --noEmit && npm run lint && npm run build && npm run test:e2e` → 통과
- [ ] **Step 5:** 측정(스크래치 스크립트): WebKit 393×787, 3분 곡 분석 완료 뒤 분석 칸 마지막 요소 bottom ≤ 저장 바 top, 큐 빌드 표시 bottom ≈ 뷰 높이 − 하단 여백. 스크린샷으로 눈 확인.
- [ ] **Step 6:** 커밋 `git add src/App.tsx src/ui/QueueScreen.tsx src/ui/EditScreen.tsx src/ui/AnalysisCard.tsx scripts/e2e.ts docs/superpowers/plans/2026-11-24-long-song-compact-ui.md`
