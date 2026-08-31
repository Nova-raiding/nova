import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/u, ''),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react'
          if (id.includes('/node_modules/@ant-design/icons/')) return 'antd-icons'
          if (id.includes('/node_modules/antd/es/')) {
            const component = id.match(/\/antd\/es\/([^/]+)/)?.[1]
            return component ? `antd-${component}` : 'antd-runtime'
          }
          if (id.includes('/node_modules/antd/')) return 'antd-runtime'
          return undefined
        },
      },
    },
  },
})
