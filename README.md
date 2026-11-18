# M4A Tag Master v2

YouTube에서 받은 `.m4a`에 제목·가수·앨범·커버·가사를 넣고, 기기 안에서 BPM·조성·코드 진행을 분석해 같은 파일 안에 넣는 웹앱(PWA)입니다. 서버 없이 아이폰 Safari에서 동작합니다.

## 현재 상태

M0(기술 스파이크): 아이폰 실기기에서 디코드·분석 시간과 메모리, 시간축, 여러 파일 공유를 재는 측정 페이지입니다.

- 배포: https://kjw5541a-hash.github.io/m4a-tag-master-v2/

## 개발

```bash
npm install
npm run dev          # 같은 Wi-Fi의 기기에서도 접속 가능 (--host)
npm run build        # 타입 검사 + 빌드
npm run check:analysis -- <m4a 파일> [multifeature|degara]   # Mac에서 분석 파이프라인 검증 (ffmpeg 필요)
```

## 라이선스

[essentia.js](https://github.com/MTG/essentia.js)(AGPL-3.0)를 포함하므로 이 저장소도 AGPL-3.0입니다.
