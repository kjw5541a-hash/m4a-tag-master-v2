# 저장 기록으로 중복 저장 막기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (인라인). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 저장한 원본·결과 파일을 기억해, 다시 넣으면 '이전에 저장함'으로 처리하고 큐 안 중복도 막는다.

**Architecture:** 새 모듈 `src/history.ts`(localStorage 래퍼)를 스토어가 쓴다. addFiles가 큐 안 중복을 거르고 기록을 조회하며, load가 기록에 있는 곡은 검색·분석 없이 'saved'로 둔다. markSaved가 기록을 쓴다.

**Tech Stack:** TypeScript, zustand, React 19, node:test

**Spec:** `docs/superpowers/specs/2026-11-24-saved-history-design.md`

## Global Constraints

- 기록 키 `${size}:${name}`, localStorage 항목 이름 `saved-files-v1`, 값 ISO 시각.
- 기록 읽기·쓰기 예외는 삼킨다(Node 테스트에는 localStorage가 없다 — 테스트가 Map 기반 stub을 단다).
- 주석·문구 한국어. `git add`는 파일 이름으로.

## Review Focus

- localStorage가 없거나 setItem이 던짐 → 저장·추가가 그대로 동작 → Task 1 테스트 '기록을 못 써도 저장은 된다'.
- 이전에 저장한 곡을 직접 검색·수정·다시 분석 → '저장 필요'로 돌아가 [모두 저장]에 들어감 → Task 1 테스트(update 경로).
- 이전에 저장한 15분 넘는 곡 → 무작위 커버를 받지 않음(검색 경로 전체를 건너뜀) → Task 1 테스트에 포함하지 않음(같은 분기), 리뷰에서 확인.
- 같은 선택 안의 중복·이미 큐에 있는 파일 → 하나만 → Task 1 테스트.

---

### Task 1: 저장 기록과 큐 중복 거르기 (스토어)

**Files:** Create `src/history.ts`; Modify `src/store.ts`; Test `src/store.test.ts`, `src/store-analysis.test.ts`(markSaved 인자)

**Interfaces (Produces):**
- `history.ts`: `fileKey(name: string, size: number): string`, `savedAt(key: string): string | undefined`, `remember(keys: string[], at?: string): void`
- `Item.fileKey?: string`, `Item.savedBefore?: string`(ISO)
- `addFiles(files): { ids: string[]; skipped: number; done: Promise<void> }`
- `markSaved(id: string, file: { name: string; size: number }): void` — 원본·결과 키를 remember, savedBefore 지움
- `statusLabel`: status 'saved'이고 savedBefore면 `이전에 저장함 (M/D)`(로컬 날짜)
- `export const SAVED_BEFORE = '이전에 저장한 곡이라 분석하지 않았어요'`

- [ ] **Step 1: 실패하는 테스트** (store.test.ts, 파일 맨 위에서 `globalThis.localStorage`를 Map 기반 stub으로)
  - `저장한 곡을 다시 넣으면 검색 없이 이전에 저장함` — add → markSaved(id, {name:'out.m4a', size: 10}) → 같은 원본 다시 add: status 'saved', savedBefore 있음, fetch 0건, statusLabel이 /^이전에 저장함 \(\d+\/\d+\)$/, analysisJob {state:'skipped', message: SAVED_BEFORE}; 결과 파일(이름 'out.m4a', 같은 크기)을 넣어도 savedBefore
  - `이전에 저장한 곡도 고치면 저장 필요` — 위 항목에 update(title) → status 'review'
  - `같은 파일은 큐에 한 번만` — 같은 File 두 개를 한 번에 add → ids 1개, skipped 1; 다시 add → ids 0개, skipped 1
  - `기록을 못 써도 저장은 된다` — setItem이 던지는 stub → markSaved 뒤 status 'saved'
- [ ] **Step 2:** `node --test src/store.test.ts` → FAIL
- [ ] **Step 3:** 구현
- [ ] **Step 4:** `npm test && npx tsc --noEmit && npm run lint` → 통과
- [ ] **Step 5:** 커밋 `git add src/history.ts src/store.ts src/store.test.ts src/store-analysis.test.ts`

### Task 2: 화면

**Files:** Modify `src/ui/QueueScreen.tsx`, `src/ui/EditScreen.tsx`, `src/ui/AnalysisCard.tsx`, `scripts/e2e.ts`

**Interfaces (Consumes):** Task 1 `addFiles().skipped`, `markSaved(id, file)`, `SAVED_BEFORE`.

- [ ] **Step 1:** QueueScreen — markSaved(b.id, b.file); skipped>0이면 파일 추가 아래 회색 글자 "이미 큐에 있는 N곡은 빼고 넣었어요"(다음 추가 때 지움).
- [ ] **Step 2:** EditScreen — markSaved(id, saved); status 'saved'면 저장 버튼 위 회색 글자 "저장한 곡이에요. 다시 저장하면 '파일'에 하나 더 생겨요".
- [ ] **Step 3:** AnalysisCard — skipped여도 메시지가 SAVED_BEFORE면 [다시 분석] 보임.
- [ ] **Step 4:** e2e — 저장된 곡 지우기 뒤 같은 a.m4a를 다시 넣으면 '이전에 저장함' 보이고 [모두 저장] 없음.
- [ ] **Step 5:** `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e` → 통과
- [ ] **Step 6:** 커밋 `git add src/ui/QueueScreen.tsx src/ui/EditScreen.tsx src/ui/AnalysisCard.tsx scripts/e2e.ts docs/superpowers/specs/2026-11-24-saved-history-design.md docs/superpowers/plans/2026-11-24-saved-history.md`
