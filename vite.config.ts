import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

// 화면에 표시해서, 기기가 서비스워커 캐시의 옛 빌드를 보고 있는지 바로 알 수 있게 한다.
function buildId() {
  const sha =
    process.env.GITHUB_SHA?.slice(0, 7) ??
    (() => {
      try {
        return execSync('git rev-parse --short HEAD').toString().trim()
      } catch {
        return 'local'
      }
    })()
  const time = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${time}Z · ${sha}`
}

// https://<user>.github.io/m4a-tag-master-v2/ 하위 경로로 배포된다.
export default defineConfig({
  base: '/m4a-tag-master-v2/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
})
