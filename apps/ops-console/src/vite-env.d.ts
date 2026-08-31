/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PROD: boolean
  readonly VITE_API_BASE?: string
  readonly VITE_OPS_AUTH_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
