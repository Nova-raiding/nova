export interface BundledInstallOptions {
  sourceRoot?: string
  home?: string
  agentsHome?: string
  codexHome?: string
  beforeConfigCommit?: () => void
  afterConfigMoved?: () => void
}

export interface BundledInstallResult {
  ok: true
  plugin: string
  version: string
  installed: string
  source: string
  registry: string
  previous_source: string | null
  previous_cache: string | null
  previous_config: string | null
  restart_required: true
  login_required: true
}

export function installBundledPlugin(options?: BundledInstallOptions): BundledInstallResult
