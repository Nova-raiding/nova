export function formatAlipayTimestamp(date?: Date): string

export function normalizePublicKey(value: unknown): string

export function signingContent(
  params: Record<string, unknown>,
  options?: { includeSignType?: boolean },
): string

export function signAlipayParams(params: Record<string, unknown>, privateKey: string): string

export function encodeAlipayParams(params: Record<string, unknown>): string

export function verifyNotifySignature(
  input: Record<string, unknown>,
  publicKey: string,
  expectedAppId: string,
): boolean

export function parseRequestBody(raw: string, contentType?: string): Record<string, unknown>

export function encodePassbackParams(value: unknown): string
export function decodePassbackParams(value: string): Record<string, unknown>

export function responseSignContent(raw: string, method: string): string
export function verifyResponseSignature(raw: string, method: string, publicKey: string): boolean
export function responseMatchesOrder(response: Record<string, unknown>, orderId: string): boolean
