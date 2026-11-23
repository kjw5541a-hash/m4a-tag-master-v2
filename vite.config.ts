import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

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
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'M4A Tag Master',
        short_name: 'Tag Master',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          // 그림을 바꾸면 파일 이름도 바꾼다(index.html 주석 참고).
          { src: 'icons/tagmaster-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/tagmaster-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/tagmaster-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 분석 워커(약 2.55MB)도 사전 캐시에 들어가게 한도를 3MB로 올린다.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/m4a-tag-master-v2/index.html',
      },
    }),
  ],
  build: {
    rollupOptions: {
      input: { index: 'index.html', m0: 'm0.html' },
    },
  },
})
