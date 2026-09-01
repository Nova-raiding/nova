import { isDeepStrictEqual } from 'node:util'
import { buildHttpConnectorConfigs, buildHttpConnectorConfigsFromStructured, createConfiguredConnector, createFakeConnector, isProductionCanaryReady, profiles, validateConnectorAuthorizationReadiness, validateConnectorReadiness, type ConfigSource, type ConnectorReadiness, type CredentialProvider, type HttpConnectorConfig, type Platform, type PlatformConnector, type StructuredPlatformConfig } from '../../../packages/connectors/src/index.js'
import { platformWriteAllowed } from '../../../packages/connectors/src/write-boundary.js'
import type { FetchLike } from '../../../packages/connectors/src/http-connector.js'
import { createPublishWorker } from '../../../packages/workers/src/factories.js'
import { createPublishHandler } from '../../../packages/workers/src/publish-adapter.js'
import type { ConnectorContext, MediaUploadInput, PlatformWriteDraft, RawProduct } from '../../../packages/connectors/src/types.js'
import type { CapabilityEvidence } from '../../../packages/connectors/src/capability-evidence.js'
import { REQUIRED_CONNECTOR_CAPABILITIES } from '../../../packages/connectors/src/readiness.js'
import { evaluatePlatformFieldMapping, type PlatformFieldMappingGateInput, type PlatformFieldMappingGateResult } from './platform-field-mapping-gate.js'

export interface ConnectorRuntimeMappingPreflightAdapter {
  sync?: (input: { platform: Platform; context: ConnectorContext; rawProduct: RawProduct }) => PlatformFieldMappingGateInput | undefined | Promise<PlatformFieldMappingGateInput | undefined>
  write?: (input: { platform: Platform; context: ConnectorContext; fields: Readonly<Record<string, unknown>>; remoteId?: string; operation: 'create' | 'update' }) => ConnectorRuntimeWriteMappingPlan | undefined | Promise<ConnectorRuntimeWriteMappingPlan | undefined>
}

export interface ConnectorRuntimeWriteMappingPlan {
  gateInput: PlatformFieldMappingGateInput
}

export class ConnectorMappingPreflightError extends Error {
  constructor(readonly stage: 'sync' | 'write', message: string, readonly result?: PlatformFieldMappingGateResult) {
    super(message)
    this.name = 'ConnectorMappingPreflightError'
  }
}

export class SyncPaginationError extends Error {
  constructor(message: string, readonly partialItems: ReturnType<PlatformConnector['mapToCanonical']>[], readonly pages: number, readonly resumeCursor?: string) {
    super(message)
    this.name = 'SyncPaginationError'
  }
}

export class ConnectorRuntime {
  readonly connectors: Readonly<Record<Platform, PlatformConnector>>
  readonly configuredHttpPlatforms: ReadonlySet<Platform>
  readonly authorizationConfiguredPlatforms: ReadonlySet<Platform>
  readonly credentialProviderConfigured: boolean
  readonly readiness: Readonly<Record<Platform, ConnectorReadiness>>
  readonly capabilityEvidence: Readonly<Record<Platform, readonly CapabilityEvidence[]>>
  private readonly mappingPreflight?: ConnectorRuntimeMappingPreflightAdapter
  private readonly productionWrites: boolean
  private readonly fixtureMode: boolean
  private readonly allowFixtureWrites: boolean
  constructor(options: { fixtureMode?: boolean; allowFixtureWrites?: boolean; connectorConfigs?: Partial<Record<Platform, HttpConnectorConfig>>; configSource?: ConfigSource; structuredConfig?: Partial<Record<Platform, StructuredPlatformConfig>>; credentialProvider?: CredentialProvider; fetch?: FetchLike; mappingPreflight?: ConnectorRuntimeMappingPreflightAdapter; environment?: 'development' | 'test' | 'production' } = {}) {
    const fixtureMode = options.fixtureMode ?? false
    this.fixtureMode = fixtureMode
    this.allowFixtureWrites = options.allowFixtureWrites ?? fixtureMode
    this.mappingPreflight = options.mappingPreflight
    this.productionWrites = (options.environment ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development')) === 'production'
    // Fixture mode is an explicit local/test choice and wins over ambient
    // environment variables. Real HTTP connectors require an explicit config
    // or non-fixture environment configuration.
    const discovered: { configs: Partial<Record<Platform, HttpConnectorConfig>>; allConfigs: Partial<Record<Platform, HttpConnectorConfig>>; candidates: Partial<Record<Platform, HttpConnectorConfig>>; readiness: Record<Platform, ConnectorReadiness> } = fixtureMode
      ? { configs: {}, allConfigs: {}, candidates: {}, readiness: Object.fromEntries((Object.keys(profiles) as Platform[]).map(platform => [platform, validateConnectorReadiness(platform, undefined)])) as Record<Platform, ConnectorReadiness> }
        : options.structuredConfig
        ? buildHttpConnectorConfigsFromStructured(options.structuredConfig)
        : buildHttpConnectorConfigs(options.configSource)
    // Instantiate OAuth-capable candidates even while catalog/publish evidence
    // is incomplete. Full read/write operations remain guarded by readiness.
    const configs = options.connectorConfigs ?? discovered.allConfigs
    this.readiness = options.connectorConfigs
      ? Object.fromEntries((Object.keys(profiles) as Platform[]).map(platform => [platform, validateConnectorReadiness(platform, options.connectorConfigs?.[platform])])) as Record<Platform, ConnectorReadiness>
      : discovered.readiness
    const evidenceConfigs = options.connectorConfigs ?? discovered.allConfigs
    this.capabilityEvidence = Object.fromEntries((Object.keys(profiles) as Platform[]).map(platform => [platform, evidenceConfigs[platform]?.capabilityEvidence ?? []])) as Record<Platform, readonly CapabilityEvidence[]>
    const configured = (Object.keys(profiles) as Platform[]).filter(platform => Boolean((options.connectorConfigs ?? discovered.configs)[platform]))
    this.configuredHttpPlatforms = new Set(configured)
    const authorizationConfigured = (Object.keys(profiles) as Platform[]).filter(platform => validateConnectorAuthorizationReadiness(platform, configs[platform]).ready)
    this.authorizationConfiguredPlatforms = new Set(authorizationConfigured)
    this.credentialProviderConfigured = fixtureMode || options.credentialProvider?.kind === 'vault' || options.credentialProvider?.kind === 'external'
    this.connectors = Object.fromEntries((Object.keys(profiles) as Platform[]).map(platform => {
      const config = configs[platform]
      return [platform, config
        ? createConfiguredConnector(platform, { config, credentials: options.credentialProvider, fetch: options.fetch })
        : createFakeConnector(platform, { configured: fixtureMode, allowFakeWrites: options.allowFixtureWrites ?? fixtureMode })]
    })) as Record<Platform, PlatformConnector>
  }

  connector(platform: Platform) { return this.connectors[platform] }

  isHttpConfigured(platform: Platform) { return this.configuredHttpPlatforms.has(platform) }
  isOAuthConfigured(platform: Platform) { return this.authorizationConfiguredPlatforms.has(platform) }
  canRead(platform: Platform) {
    // Configuration and credentials are necessary but not sufficient. The
    // connector must also pass mapping/signing/capability evidence gates.
    return this.isHttpConfigured(platform) && this.credentialProviderConfigured && this.readiness[platform]?.ready === true
  }

  capabilityMatrix(platform: Platform) {
    const evidence = this.capabilityEvidence[platform] ?? []
    return REQUIRED_CONNECTOR_CAPABILITIES.map(capability => {
      const item = evidence.find(candidate => candidate.platform === platform && candidate.capability === capability)
      return { capability, state: item?.state ?? 'unverified', ...(item?.evidenceRef ? { evidenceRef: item.evidenceRef } : {}), ...(item?.verifiedBy ? { verifiedBy: item.verifiedBy } : {}), ...(item?.verifiedAt ? { verifiedAt: item.verifiedAt } : {}), ...(item?.apiVersion ? { apiVersion: item.apiVersion } : {}), ...(item?.scope ? { scope: item.scope } : {}) }
    })
  }

  mediaUploadReady(platform: Platform) {
    const connector = this.connector(platform) as PlatformConnector & { mediaUploadReady?: () => boolean }
    return typeof connector.uploadMedia === 'function' && connector.mediaUploadReady?.() === true
  }

  mediaUploadReadiness(platform: Platform) {
    const connector = this.connector(platform) as PlatformConnector & { mediaUploadReadiness?: () => { configured: boolean; evidence: boolean; ready: boolean } }
    return connector.mediaUploadReadiness?.() ?? { configured: false, evidence: false, ready: false }
  }

  private async preflightSync(platform: Platform, context: ConnectorContext, rawProduct: RawProduct) {
    if (!this.mappingPreflight?.sync) return
    const gateInput = await this.mappingPreflight.sync({ platform, context, rawProduct })
    // Read-only synchronization must remain available before a merchant has
    // approved a write mapping. When an approval exists we validate it, but an
    // absent approval is not a reason to block importing the source record.
    if (!gateInput) return
    const result = evaluatePlatformFieldMapping(gateInput)
    if (result.platform !== platform || result.rawSource.productId.normalize('NFKC').trim() !== rawProduct.remoteId.normalize('NFKC').trim()) throw new ConnectorMappingPreflightError('sync', `mapping preflight scope does not match ${platform}/${rawProduct.remoteId}`, result)
    if (!result.mappingSafe || result.externallyUnverified) throw new ConnectorMappingPreflightError('sync', `mapping preflight blocked ${platform} sync: ${result.blocks.map(finding => finding.code).join(', ')}`, result)
  }

  private async preflightWrite(input: { platform: Platform; context: ConnectorContext; fields: Record<string, unknown>; remoteId?: string }) {
    const adapter = this.mappingPreflight?.write
    if (!adapter) {
      if (this.productionWrites) throw new ConnectorMappingPreflightError('write', `production write for ${input.platform} requires a verified schema/mapping preflight adapter`)
      return input.fields
    }
    const operation = input.remoteId ? 'update' : 'create'
    let requestedFields: Record<string, unknown>
    try { requestedFields = structuredClone(input.fields) } catch { throw new ConnectorMappingPreflightError('write', `write fields for ${input.platform} must be structured-cloneable`) }
    const plan = await adapter({ platform: input.platform, context: input.context, fields: requestedFields, ...(input.remoteId ? { remoteId: input.remoteId } : {}), operation })
    if (!plan) throw new ConnectorMappingPreflightError('write', `mapping preflight adapter returned no schema/mapping plan for ${input.platform} ${operation}`)
    const result = evaluatePlatformFieldMapping(plan.gateInput)
    if (result.platform !== input.platform) throw new ConnectorMappingPreflightError('write', `mapping preflight scope does not match ${input.platform}`, result)
    if (!isDeepStrictEqual(result.rawSource.productFields, requestedFields)) throw new ConnectorMappingPreflightError('write', `mapping preflight source fields do not match the ${input.platform} ${operation} request`, result)
    if (!result.publishable || result.externallyUnverified) throw new ConnectorMappingPreflightError('write', `mapping preflight blocked ${input.platform} ${operation}: ${result.blocks.map(finding => finding.code).join(', ')}`, result)
    if (result.mappedPayload.skus.some(item => Object.keys(item.fields).length > 0)) throw new ConnectorMappingPreflightError('write', 'connector runtime does not support implicit SKU flattening; use a connector with an explicit per-SKU write contract', result)
    const selected = result.mappedPayload.product
    const safeFields = Object.create(null) as Record<string, unknown>
    const seen = new Set<string>()
    for (const [field, value] of Object.entries(selected)) {
      const canonical = field.normalize('NFKC').trim()
      if (!canonical || seen.has(canonical) || ['__proto__', 'constructor', 'prototype'].includes(canonical)) throw new ConnectorMappingPreflightError('write', `mapping adapter emitted an unsafe or duplicate connector field: ${field}`, result)
      seen.add(canonical)
      Object.defineProperty(safeFields, canonical, { value: structuredClone(value), enumerable: true, writable: true, configurable: true })
    }
    return safeFields
  }

  private assertWriteAllowed(platform: Platform) {
    const allowed = platformWriteAllowed({
      production: this.productionWrites,
      fixtureMode: this.fixtureMode,
      connectorConfigured: this.fixtureMode || this.isHttpConfigured(platform),
      pluginWriteEnabled: this.allowFixtureWrites,
      canaryReady: isProductionCanaryReady(this.capabilityEvidence[platform] ?? [], platform),
    })
    if (!allowed) {
      throw new Error(`platform write is not admitted for ${platform}: connector configuration, production canary evidence, or fixture policy is missing`)
    }
  }

  async sync(platform: Platform, context: ConnectorContext, initialCursor?: string, onPage?: (page: { pageNumber: number; cursor?: string; nextCursor?: string; items: ReturnType<PlatformConnector['mapToCanonical']>[]; source: 'fixture' | 'official_api'; simulated: boolean }) => Promise<void> | void) {
    const connector = this.connector(platform)
    const items = [] as ReturnType<typeof connector.mapToCanonical>[]
    const seenCursors = new Set<string>()
    let cursor = initialCursor
    let source: 'fixture' | 'official_api' = 'official_api'
    let simulated = false
    let pages = 0
    let nextCursor: string | undefined
    do {
      context.signal?.throwIfAborted()
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error(`connector returned a repeated sync cursor for ${platform}`)
        seenCursors.add(cursor)
      }
      try {
        const page = await connector.syncProducts(context, cursor ? { value: cursor } : undefined)
        context.signal?.throwIfAborted()
        pages += 1
        if (pages > 1000) throw new Error(`connector pagination exceeded the safety limit for ${platform}`)
        source = page.source
        simulated = simulated || page.simulated
        const mappedItems = [] as ReturnType<typeof connector.mapToCanonical>[]
        for (const item of page.items) {
          await this.preflightSync(platform, context, item)
          mappedItems.push(connector.mapToCanonical(item, { id: `${platform}.mapping.v1` }))
        }
        nextCursor = page.nextCursor?.value
        await onPage?.({ pageNumber: pages, ...(cursor ? { cursor } : {}), ...(nextCursor ? { nextCursor } : {}), items: mappedItems, source: page.source, simulated: page.simulated })
        context.signal?.throwIfAborted()
        items.push(...mappedItems)
        cursor = nextCursor
      } catch (error) {
        if (error instanceof SyncPaginationError) throw error
        throw new SyncPaginationError(error instanceof Error ? error.message : 'connector sync failed', items, pages, cursor)
      }
    } while (nextCursor)
    return { platform, source, simulated, pages, items, ...(nextCursor ? { nextCursor } : {}) }
  }

  async publish(input: { platform: Platform; context: ConnectorContext; fields: Record<string, unknown>; remoteId?: string; idempotencyKey: string }) {
    const connector = this.connector(input.platform)
    const fields = await this.preflightWrite(input)
    this.assertWriteAllowed(input.platform)
    const worker = createPublishWorker(createPublishHandler(connector, async payload => ({ accountId: input.context.accountId, fields: payload.fields ?? {}, ...payload })))
    const job = worker.enqueue({ workspaceId: input.context.workspaceId, idempotencyKey: input.idempotencyKey, payload: { taskId: 'runtime-task', contentVersionId: 'runtime-content', platform: input.platform, idempotencyKey: input.idempotencyKey, fields: { ...fields, ...(input.remoteId ? { remoteId: input.remoteId } : {}) } } })
    await worker.runNext()
    return { job, connectorStatus: worker.jobs.get(job.id) }
  }

  /** Execute one durable-worker publish and immediately verify remote status. */
  async executePublish(input: { platform: Platform; context: ConnectorContext; fields: Record<string, unknown>; remoteId?: string; idempotencyKey: string; media?: MediaUploadInput[] }) {
    const connector = this.connector(input.platform)
    input.context.signal?.throwIfAborted()
    let fields = await this.preflightWrite(input)
    this.assertWriteAllowed(input.platform)
    if (input.media?.length) {
      if (typeof connector.uploadMedia !== 'function') throw new Error('selected product visuals require a platform media upload adapter')
      const uploaded = []
      for (const media of input.media) {
        input.context.signal?.throwIfAborted()
        uploaded.push(await connector.uploadMedia(input.context, media))
      }
      const imageRefs = uploaded.map(item => item.url ?? item.mediaId)
      if (imageRefs.some(value => !value)) throw new Error('platform media upload returned no usable image reference')
      fields = { ...fields, images: imageRefs }
    }
    const findings = connector.validateWrite({ fields, ...(input.remoteId ? { remoteId: input.remoteId } : {}), idempotencyKey: input.idempotencyKey })
    if (findings.some(finding => finding.severity === 'error')) throw new Error(findings.map(finding => finding.message).join('; '))
    const context = input.context
    const draft = { fields, ...(input.remoteId ? { remoteId: input.remoteId } : {}), idempotencyKey: input.idempotencyKey }
    const receipt = input.remoteId
      ? await connector.updateProduct(context, draft)
      : await connector.createProduct(context, draft)
    // Client cancellation cannot prove whether a third-party accepted a write.
    // Every retry reuses this stable key so an uncertain commit is reconciled,
    // never repeated as a distinct platform mutation.
    context.signal?.throwIfAborted()
    const remoteStatus = await connector.queryWrite(context, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId })
    context.signal?.throwIfAborted()
    return { receipt, remoteStatus }
  }

  async executeReconcile(input: { platform: Platform; context: ConnectorContext; remoteId?: string; idempotencyKey: string }) {
    const connector = this.connector(input.platform)
    input.context.signal?.throwIfAborted()
    const remoteStatus = await connector.queryWrite(input.context, { idempotencyKey: input.idempotencyKey, ...(input.remoteId ? { remoteId: input.remoteId } : {}) })
    input.context.signal?.throwIfAborted()
    return { remoteStatus }
  }
}

export type { PlatformWriteDraft }
