import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  define: {
    // Keep acceptance/prod auth mode deterministic in the emitted bundle;
    // relying only on ambient import.meta.env made isolated OIDC E2E fall
    // back to the local merchant workspace path.
    'import.meta.env.VITE_OPS_AUTH_MODE': JSON.stringify(process.env.VITE_OPS_AUTH_MODE || ''),
    'import.meta.env.VITE_OPS_BUILD_MODE': JSON.stringify(process.env.VITE_OPS_BUILD_MODE || ''),
    // Keep the managed OIDC runner's same-origin API boundary deterministic
    // in both dev and production builds. Without an explicit value, a Vite
    // environment mismatch can leave hasOpsConnection() false and prevent
    // the first ops.session request from ever reaching the gateway.
    'import.meta.env.VITE_API_BASE': JSON.stringify(process.env.VITE_API_BASE || ''),
    // Local Compose obtains an HttpOnly session from the API; the browser
    // never receives or stores the bearer token.
    'import.meta.env.VITE_OPS_LOCAL_SESSION': JSON.stringify(process.env.VITE_OPS_LOCAL_SESSION || ''),
  },
  plugins: [react()],
  server: {
    hmr: process.env.VITE_OPS_E2E !== 'true',
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
        // The local OIDC gateway owns the `/api/*` boundary and uses it to
        // distinguish authenticated UI traffic from static assets.  Stripping
        // the prefix makes `/api/mcp` arrive as `/mcp`, bypassing the gateway
        // session proof path.  Direct API targets still expect the historical
        // `/mcp` path, so only rewrite when explicitly targeting the API port.
        rewrite: path => {
          const target = process.env.VITE_API_PROXY_TARGET || ''
          return /:(8787|8797)(?:\/|$)/u.test(target) ? path.replace(/^\/api/u, '') : path
        },
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
