# M4A Tag Master v2

YouTube에서 받은 `.m4a`에 제목·가수·앨범·커버·가사를 넣고, 기기 안에서 BPM·조성·코드 진행을 분석해 같은 파일 안에 넣는 웹앱(PWA)입니다. 서버 없이 아이폰 Safari에서 동작합니다.

## 현재 상태

M2(곡 하나 처리): m4a 한 곡을 넣으면 파일명·태그에서 검색어를 정리하고, iTunes에서 곡 정보와 커버를, LRCLIB에서 가사를 찾아 채웁니다. 편집 화면에서 확인·수정한 뒤 [저장 · 공유]로 태그가 들어간 새 파일을 만듭니다(원본은 수정하지 않습니다). 분석(BPM·조성·코드)과 여러 곡 일괄 저장은 아직 없습니다. 측정 페이지(M0)는 `/m0.html`에 남아 있습니다.

- 배포: https://kjw5541a-hash.github.io/m4a-tag-master-v2/

## 개발

```bash
npm install
npm run dev          # 같은 Wi-Fi의 기기에서도 접속 가능 (--host)
npm run build        # 타입 검사 + 빌드
npm test             # 단위 테스트 (node:test, ffmpeg 필요)
npm run test:e2e     # 빌드 후 Chrome(Playwright)으로 한 곡 저장까지 스모크 테스트 (Google Chrome·ffmpeg 필요, CI에는 넣지 않음)
npm run check:analysis -- <m4a 파일> [multifeature|degara]   # Mac에서 분석 파이프라인 검증 (ffmpeg 필요)
```

## 라이선스

[essentia.js](https://github.com/MTG/essentia.js)(AGPL-3.0)를 포함하므로 이 저장소도 AGPL-3.0입니다.
