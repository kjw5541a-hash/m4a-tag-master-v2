# 코드를 반 마디 단위로 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (사용자가 인라인 실행을 골랐다). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BPM을 먼저 정하고(120 이상 ÷2) 그 BPM의 반 마디(2박)마다 코드 하나를 고르며, 사용자가 BPM을 고치면 코드를 다시 묶는다.

**Architecture:** analyze()는 essentia로 비트·HPCP만 구하고, 비트 사이 평균 크로마(BeatChroma)를 만든다. 코드 고르기는 essentia 없이 도는 순수 함수 `chordsFromChroma`(3화음 틀 코사인 + 주변 장음계 가산점 + 묶음 시작점 선택). 크로마는 곡 항목 메모리에 두고 BPM 수정 시 `regroup`으로 다시 묶는다.

**Tech Stack:** TypeScript, essentia.js 0.1.3(WASM, 워커), zustand, node:test

**Spec:** `docs/superpowers/specs/2026-11-23-half-bar-chords-design.md`

## Global Constraints

- 스키마 v1 그대로. `ANALYZER = 'm4a-tag-master@3 essentia.js@0.1.3'`.
- 코드 이름은 지금과 같은 # 표기 3화음(`C`, `A#m`)과 `N`.
- 크로마 배열은 C 기준(0=C … 11=B). essentia HPCP는 0=A이므로 analyze에서 돌려 넣는다.
- 구간은 0초부터 곡 끝까지 빈틈없이, 시간은 소수 둘째 자리(toAnalysis가 반올림).
- 주석·문구 한국어. `git add`는 파일 이름으로.

## Review Focus

- 비트가 하나도 없는 곡(무음·아주 짧은 곡) → 곡 전체가 한 구간(N 또는 코드 하나), 예외 없음 → Task 1 테스트 'chordsFromChroma: 비트가 없으면 곡 전체 한 구간'.
- BPM을 아주 크게(×2 반복) 바꾸면 묶음 크기 1 미만이 되지 않는다 → Task 1 테스트(bpm 1000 근처에서 k=1).
- 파일에서 읽은 분석(크로마 없음)에서 BPM을 고치면 코드는 그대로, BPM만 바뀐다 → Task 3 테스트.
- 분석이 돌아오기 전에 BPM을 고칠 수 없음(카드가 그리지 않음) — 기존 동작 유지, 별도 테스트 없음.
- 사용자가 BPM을 고친 뒤 [다시 분석]하면 크로마와 BPM이 새 분석 값으로 바뀐다 → Task 3 테스트.

---

### Task 1: 순수 함수 — BPM 보정, 반 마디 묶기, 코드 고르기, 다시 묶기

**Files:** Modify `src/analysis.ts`; Test `src/analysis.test.ts`

**Interfaces (Produces):**
```ts
export interface BeatChroma {
  detectedBpm: number   // essentia가 잡은 BPM(비트 간격의 기준)
  bounds: number[]      // [0, ...비트(초), 곡 길이] 오름차순
  chroma: number[][]    // chroma[i] = [bounds[i], bounds[i+1]) 평균 크로마, 12개, 0=C
}
export function musicalBpm(detected: number): number          // detected >= 120 ? detected / 2 : detected
export function chordsFromChroma(c: BeatChroma, bpm: number): ChordSegment[]
export function regroup(a: MappAnalysisV1, c: BeatChroma): MappAnalysisV1 // a.bpm 기준으로 chords·topProgressions만 바꿈
```

**알고리즘 (테스트가 정하지 않는 부분):**
- 묶음 크기 `k = max(1, round(2 * c.detectedBpm / bpm))`. 경계 = `[0, bounds[1+o], bounds[1+o+k], …, 곡 끝]` (o = 0..k-1 중 선택).
- 묶음 크로마 = 구간 길이로 가중한 평균. 3화음 틀(장: 0·4·7, 단: 0·3·7) 24개와 코사인. 크로마 합이 1e-6 미만이면 N.
- 주변 음계: 묶음 g 앞뒤 8묶음의 크로마 합(길이 가중)에 장음계 7음 합이 가장 큰 근음 r. 그 음계의 3화음(장: r, r+5, r+7 / 단: r+2, r+4, r+9) 점수 ×1.1.
- 가산점 뒤 최고 점수가 `N_MIN` 미만이면 N(Task 2에서 참고곡으로 정함, 처음엔 0.5).
- 시작점 o: 묶음마다 가산점 전 최고 코사인의 합이 가장 큰 o(같으면 작은 o).
- 같은 코드 연속은 합친다.

- [ ] **Step 1: 실패하는 테스트** (`finalizeChords` 테스트 2개는 Task 2에서 지운다)
  - 도우미: `beats(detectedBpm, step, duration, at: (t) => number[])` — bounds `[0, step, 2·step, …, duration]`, 구간 시작 t의 크로마. `triad(root, minor?)` C 기준 12칸.
  - `musicalBpm: 120 이상은 반으로` — 134.9→67.45, 120→60, 117.7→117.7
  - `chordsFromChroma: BPM의 2박마다 묶어 잠깐 지나가는 소리는 묻힌다` — detected 120, step 0.5, 8초, t<4 C·t≥4 G, 단 [2.0,2.5)는 F → bpm 60: `[{0,4,C},{4,8,G}]`, bpm 240(k=1): 결과에 F 있음
  - `chordsFromChroma: 코드가 바뀌는 비트에 묶음 경계를 맞춘다` — step 0.5, 9초, [0,1) Am, [1,3) C, [3,5) G, [5,7) F, [7,9) C, detected 120, bpm 60 → 시작 시각들 `[0,1,3,5,7]`
  - `chordsFromChroma: 애매하면 주변 조성의 코드를 고른다` — 가운데 한 묶음 크로마 E=1,B=1,G=0.5,G#=0.5. 앞뒤가 C·F·G·Am이면 그 묶음은 `Em`, 앞뒤가 E·A·B면 `E`
  - `chordsFromChroma: 소리가 없으면 N, 구간은 0부터 곡 끝까지 빈틈없다` — 전부 0 → `[{0,dur,N}]`; 앞 테스트 결과들도 이어짐 확인
  - `chordsFromChroma: 비트가 없으면 곡 전체 한 구간` — bounds `[0, 5]`, C 크로마 → `[{0,5,C}]`
  - `chordsFromChroma: BPM이 아주 커도 묶음은 1비트` — bpm 999 → bpm 240 결과와 같음
  - `regroup: a.bpm 기준으로 chords·topProgressions를 바꾸고 나머지는 그대로`
- [ ] **Step 2:** `node --test src/analysis.test.ts` → import 실패로 FAIL
- [ ] **Step 3:** 구현
- [ ] **Step 4:** `node --test src/analysis.test.ts` → PASS
- [ ] **Step 5:** 커밋 `git add src/analysis.ts src/analysis.test.ts`

### Task 2: analyze()를 새 방식으로

**Files:** Modify `src/analysis.ts`, `src/analysis.test.ts`(finalizeChords 테스트 삭제)

**Interfaces:** `AnalysisResult`에 `beatChroma: BeatChroma` 추가, `bpm`은 `musicalBpm(검출)`. `finalizeChords`·`BeatChord`·`ChordsDetectionBeats` 호출 삭제.

- [ ] **Step 1:** HPCP 프레임을 JS 배열로 모으고(0=A → 0=C로 회전), `[0, ...ticks, duration]` 구간마다 프레임 중심(i·HOP/SR)이 들어가는 프레임 평균 → BeatChroma. `chords = chordsFromChroma(beatChroma, bpm)`. ANALYZER @3.
- [ ] **Step 2:** 참고곡으로 확인: `node <scratch>/ben.ts "<180도>"` 와 '산책' → BPM 67.5·66.1 근처, 구간 수·중앙 길이(반 마디 ≈1.8초 근처), N 비율을 보고 N_MIN을 정해 ledger에 적는다.
- [ ] **Step 3:** `npm test && npx tsc --noEmit && npm run lint` → 통과
- [ ] **Step 4:** 커밋 `git add src/analysis.ts src/analysis.test.ts`

### Task 3: 크로마를 곡 항목에 두고 BPM을 고치면 다시 묶기

**Files:** Modify `src/runAnalysis.ts`, `src/store.ts`, `src/ui/AnalysisCard.tsx`, `src/store-analysis.test.ts`, `src/store.test.ts`(runner 반환형)

**Interfaces:**
- `runAnalysis(bytes, onProgress): Promise<{ analysis: MappAnalysisV1; chroma: BeatChroma }>`
- `Item.chroma?: BeatChroma` (메모리 전용, 파일에 안 씀)
- Queue 액션 `editAnalysis(id: string, patch: Partial<Pick<MappAnalysisV1, 'bpm'|'key'|'scale'>>): void` — schema `editAnalysis` 뒤 bpm이 바뀌었고 chroma가 있으면 `regroup`, 바뀐 게 있을 때만 update. AnalysisCard의 `change`는 이것을 부른다.

- [ ] **Step 1: 실패하는 테스트** (store-analysis.test.ts)
  - `editAnalysis: 분석 크로마가 있으면 BPM을 바꿀 때 코드를 다시 묶는다` — runner가 `{ analysis, chroma }`(Task 1 도우미 모양의 C/G 크로마, detected 120, analysis.bpm 120) 반환 → 분석 끝난 뒤 `editAnalysis(id, {bpm: 60})` → chords가 `chordsFromChroma(chroma, 60)`과 같고 bpm 60, edited true
  - `editAnalysis: 파일에서 읽은 분석(크로마 없음)은 BPM만 바뀐다`
  - `다시 분석하면 크로마와 BPM이 새 분석 값으로 바뀐다`
  - 기존 `setAnalysisRunner(async … => analysis)`들은 `{ analysis, chroma }` 반환으로 바꾼다
- [ ] **Step 2:** `node --test src/store-analysis.test.ts` → FAIL
- [ ] **Step 3:** 구현 (worker → runAnalysis가 result.beatChroma를 함께 돌려줌, store.analyze가 chroma 저장)
- [ ] **Step 4:** `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e` → 통과. WebKit 스크립트로 11분 곡 분석 완료 확인
- [ ] **Step 5:** 커밋 `git add src/runAnalysis.ts src/store.ts src/ui/AnalysisCard.tsx src/store-analysis.test.ts src/store.test.ts docs/superpowers/specs/2026-11-23-half-bar-chords-design.md docs/superpowers/plans/2026-11-23-half-bar-chords.md`
