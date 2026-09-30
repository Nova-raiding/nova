import { COMMERCIAL_OPERATION_REGISTRY, MCP_METHOD_CONTRACTS, MCP_NON_PRODUCTION_METHODS, getMcpMethodPolicy, resolveCommercialOperation } from '../../../packages/contracts/src/index.js'

const NATIVE_MCP_METHODS_WITHOUT_TRANSPORT = new Set([
  // The API has no multipart upload transport configured. Keep these out of
  // every advertised MCP surface until the transport is implemented.
  'upload.session.create', 'upload.session.part', 'upload.session.complete',
])

function localVideoCandidatesEnabled() {
  if (process.env.MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES !== 'true') return false
  if (process.env.NODE_ENV !== 'development' || process.env.CONNECTOR_FIXTURE_MODE !== 'true' || process.env.MERCHANT_TEST_APPROVED_RATES !== 'true') return false
  try {
    const hostname = new URL(process.env.MERCHANT_MCP_BASE_URL ?? '').hostname
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

export function isNativeMcpToolEnabled(method: string, paymentReady: () => boolean) {
  if (NATIVE_MCP_METHODS_WITHOUT_TRANSPORT.has(method)) return false
  // Rendering is a local QA-only capability and must never become visible
  // merely because a commercial registry entry is present.
  if (method === 'multimodal.video.request' || method === 'multimodal.video.get') return localVideoCandidatesEnabled()
  // Expose the recharge entry only after the production provider is configured.
  // Fixture and incomplete environments remain hidden from ChatGPT.
  if (method === 'billing.recharge.create' && process.env.PAYMENT_MODE === 'provider' && paymentReady()) return true
  if (method.startsWith('ops.') || (MCP_NON_PRODUCTION_METHODS as readonly string[]).includes(method)) return false
  if (!MCP_METHOD_CONTRACTS.some(contract => contract.method === method)) return false
  if (method === 'catalog.image.generate' && process.env.NODE_ENV === 'development' && process.env.CONNECTOR_FIXTURE_MODE === 'true' && process.env.MERCHANT_TEST_APPROVED_RATES === 'true') return true
  return resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation: method }).outcome === 'REGISTERED'
}

// Keep native HTTP MCP annotations aligned with the installed Bridge. Most
// methods can derive their read-only hint from the authoritative authz policy;
// these legacy preview/inspection operations are deliberately read-only in
// the Bridge even though their service policy is a write effect for lifecycle
// or permission purposes.
const NATIVE_READ_ONLY_ANNOTATION_EXCEPTIONS = new Set([
  'brand.extract', 'brand.tone.preview', 'task.resume',
  'task.understand', 'content.review',
  'delivery.bundle.verify',
])
const NATIVE_DESTRUCTIVE_ANNOTATION_METHODS = new Set([
  'platform.revoke', 'workspace.deactivate', 'workspace.data.delete.request',
  'ops.data.delete.cancel', 'ops.data.delete.approve', 'catalog.product.disable',
  'automation.pause', 'publish.confirm', 'publish.batch.confirm',
])

function nativeMcpToolAnnotations(method: string) {
  const policy = getMcpMethodPolicy(method)
  const readOnly = policy?.effect === 'read' || NATIVE_READ_ONLY_ANNOTATION_EXCEPTIONS.has(method)
  if (readOnly) return { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  if (method === 'merchant.start') return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (method === 'catalog.image.select' || method === 'catalog.image.retry' || method === 'content.visual.select') return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (method === 'content.export') return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  const destructive = NATIVE_DESTRUCTIVE_ANNOTATION_METHODS.has(method)
  return { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: destructive }
}

export function nativeMcpTools(paymentReady: () => boolean) {
  return MCP_METHOD_CONTRACTS
    .filter(contract => isNativeMcpToolEnabled(contract.method, paymentReady))
    .map(contract => ({
      name: contract.method,
      description: contract.description,
      inputSchema: contract.params,
      annotations: nativeMcpToolAnnotations(contract.method),
    }))
}
