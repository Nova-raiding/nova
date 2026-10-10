import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupDiagnostics, type SetupDiagnosticsDependencies } from './health-setup.js'

vi.mock('../../../packages/ai/src/platform-model-gate.js', () => ({
  evaluatePlatformModelRelayGate: () => ({ ready: true, reasons: [] }),
  evaluatePlatformModelGate: () => ({ ready: true, https: true, reasons: [] }),
  evaluatePlatformModelCostGate: () => ({ ready: true, rpm: 10, tpm: 1000, dailyCnyLimit: 20, reasons: [] }),
  evaluatePlatformModelTaskCostLimit: () => ({ ready: true, costCny: 0, limitCny: 5, reasons: [] }),
}))

afterEach(() => vi.unstubAllEnvs())

describe('setup diagnostics demo gate boundary', () => {
  it('keeps demo productionGate false without changing the payment readiness input', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('DEMO_RUNTIME_MODE', 'true')
    vi.stubEnv('PLATFORM_OPERATIONS_MODE', 'manual')
    vi.stubEnv('ASSET_STORAGE_SSE_MODE', 'AES256')
    vi.stubEnv('OPS_ALERT_NOTIFICATIONS_ENABLED', 'false')

    let paymentGate: boolean | undefined
    const dependencies = {
      isProduction: () => true,
      fixtureMode: false,
      paymentProviderReadiness: () => ({ ready: true, reasons: [], supportedChannels: ['alipay'] as const, channelReadiness: { alipay: { ready: true, reasons: [] } } }),
      productionPaymentReadiness: () => ({ ready: true, reasons: [] }),
      imageFactsExtractor: {},
      imageEditGenerator: {},
      videoGenerator: {},
      requiredModelCostEvidenceByModality: () => ({ text: true, image: true, image_edit: true, ocr: true, video: true, embedding: true }),
      connectorRuntime: { credentialProviderConfigured: true, readiness: {}, isHttpConfigured: () => false, isOAuthConfigured: () => false, canRead: () => false },
      configuredEnv: () => true,
      lifecycleDiagnostics: () => ({ configured: true }),
      productionReadinessDiagnostics: () => ({ required: false, ready: true, gates: {} }),
      evidenceReadiness: () => ({ configured: true, state: 'ready', reasons: [] }),
      SUPPORTED_PLATFORMS: [],
      manualPlatformEnabled: () => true,
      fixturePlatformEnabled: () => false,
      paymentCapabilityStatus: ((input: { productionGate: boolean }) => {
        paymentGate = input.productionGate
        return { effective: input.productionGate }
      }) as SetupDiagnosticsDependencies['paymentCapabilityStatus'],
    } as unknown as SetupDiagnosticsDependencies

    const setup = setupDiagnostics({ commercialReadiness: { ready: true, reasons: [] } }, dependencies)

    expect(setup.mode).toBe('demo')
    expect(setup.productionGate).toBe(false)
    expect(paymentGate).toBe(true)
    expect(setup.payment).toMatchObject({ effective: true })
  })
})
