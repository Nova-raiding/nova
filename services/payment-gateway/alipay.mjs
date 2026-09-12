import crypto from 'node:crypto'

// Alipay's OpenAPI 2.0 protocol uses a wall-clock timestamp in China Standard
// Time (UTC+08:00), not an ISO UTC timestamp.  Keep this independent of the
// container's TZ setting (the production image intentionally uses UTC).
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function formatAlipayTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('invalid date')
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Normalize the public key formats emitted by Alipay's key tools.
 *
 * Alipay may provide a bare base64 SubjectPublicKeyInfo value, a PUBLIC KEY
 * PEM, an RSA PUBLIC KEY PEM, or a public-key certificate.  Node's crypto
 * verifier accepts the first three directly; certificates are converted to
 * their contained SPKI key so the same path works for both key modes.
 */
export function normalizePublicKey(value) {
  const input = String(value ?? '').trim().replace(/\\n/g, '\n')
  if (!input) throw new Error('ALIPAY_PUBLIC_KEY is required')

  if (/-----BEGIN CERTIFICATE-----/u.test(input)) {
    try {
      return new crypto.X509Certificate(input).publicKey.export({ format: 'pem', type: 'spki' }).toString()
    } catch {
      throw new Error('ALIPAY_PUBLIC_KEY certificate is invalid')
    }
  }

  if (/-----BEGIN (?:PUBLIC KEY|RSA PUBLIC KEY)-----/u.test(input)) {
    try {
      // Re-exporting makes line endings and PKCS#1/SPKI variants consistent.
      return crypto.createPublicKey(input).export({ format: 'pem', type: 'spki' }).toString()
    } catch {
      throw new Error('ALIPAY_PUBLIC_KEY is invalid')
    }
  }

  const base64 = input.replace(/\s/g, '')
  if (!base64 || !/^[A-Za-z0-9+/=]+$/u.test(base64)) throw new Error('ALIPAY_PUBLIC_KEY must be PEM or base64')
  const pem = `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`
  try {
    return crypto.createPublicKey(pem).export({ format: 'pem', type: 'spki' }).toString()
  } catch {
    throw new Error('ALIPAY_PUBLIC_KEY base64 is invalid')
  }
}

/**
 * Build the OpenAPI 2.0 canonical string.  Values are deliberately *not* URL
 * encoded before signing; encoding is applied only when serializing the HTTP
 * request.  Request signatures include sign_type (as in Alipay's current
 * OpenAPI SDKs); notification signatures historically omit it, so callers can
 * select the compatibility mode explicitly.
 */
export function signingContent(params, { includeSignType = true } = {}) {
  return Object.keys(params)
    .filter(key => key !== 'sign' && (includeSignType || key !== 'sign_type'))
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map(key => `${key}=${String(params[key])}`)
    .join('&')
}

export function signAlipayParams(params, privateKey) {
  return crypto.createSign('RSA-SHA256').update(signingContent(params), 'utf8').sign(privateKey, 'base64')
}

/** Serialize query/form values the same way as Alipay's official SDK. */
export function encodeAlipayParams(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}

/**
 * Verify an asynchronous notification.  Alipay's documented notification
 * form excludes sign and sign_type.  A small number of legacy integrations
 * included sign_type, so we accept that form only as a second, explicit
 * compatibility attempt; both paths still require a valid RSA2 signature.
 * The expected app id is required so a valid notification for a different
 * Alipay application cannot be replayed against this gateway (the Alipay
 * platform public key is shared across applications).
 */
export function verifyNotifySignature(input, publicKey, expectedAppId) {
  const signature = typeof input?.sign === 'string' ? input.sign : ''
  if (!signature) return false
  if (typeof expectedAppId !== 'string' || !expectedAppId.trim() || typeof input?.app_id !== 'string' || input.app_id !== expectedAppId.trim()) return false
  if (input?.sign_type && String(input.sign_type).toUpperCase() !== 'RSA2') return false

  const withoutSignType = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'sign' && key !== 'sign_type'))
  const suppliedSignType = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'sign'))
  // Some Alipay notification SDK versions omit sign_type from the form while
  // still signing the canonical string with the protocol default RSA2. Try
  // that explicit default as a compatibility path, then the documented form.
  const withDefaultSignType = { ...withoutSignType, sign_type: 'RSA2' }
  for (const [params, includeSignType] of [[withoutSignType, false], [withDefaultSignType, true], [suppliedSignType, Object.prototype.hasOwnProperty.call(suppliedSignType, 'sign_type')]]) {
    const content = signingContent(params, { includeSignType })
    try {
      if (crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(publicKey, signature, 'base64')) return true
    } catch {
      // A malformed signature must be treated as an ordinary verification
      // failure, never as a gateway crash.
    }
  }
  return false
}

/** Parse either Alipay's form callback or our internal JSON requests. */
export function parseRequestBody(raw, contentType = '') {
  if (!raw) return {}
  const mediaType = String(contentType).split(';', 1)[0].trim().toLowerCase()
  if (mediaType === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw))
  if (mediaType === 'application/json' || !mediaType) return JSON.parse(raw)
  throw new Error(`unsupported content type: ${mediaType}`)
}

/** Alipay requires passback_params to be URL-encoded inside biz_content. */
export function encodePassbackParams(value) {
  return encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value))
}

export function decodePassbackParams(value) {
  if (typeof value !== 'string' || value === '') return {}
  const candidates = [value]
  try {
    const decoded = decodeURIComponent(value)
    if (decoded !== value) candidates.push(decoded)
  } catch {
    // Keep the original candidate; malformed percent escapes are rejected by
    // the JSON parse below and cannot influence authorization.
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Try the next representation.
    }
  }
  return {}
}

function scanJsonValueEnd(raw, start) {
  const first = raw[start]
  if (first !== '{' && first !== '[') {
    let i = start
    let quoted = false
    let escaped = false
    for (; i < raw.length; i += 1) {
      const char = raw[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === ',' || char === '}') break
    }
    return i
  }

  const stack = []
  let quoted = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '['
      if (stack.pop() !== expected) return -1
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}

function scanJsonStringEnd(raw, start) {
  if (raw[start] !== '"') return -1
  let escaped = false
  for (let i = start + 1; i < raw.length; i += 1) {
    const char = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') return i + 1
  }
  return -1
}

function skipJsonWhitespace(raw, start) {
  let index = start
  while (/\s/u.test(raw[index] ?? '')) index += 1
  return index
}

/**
 * Return the exact bytes of one response object at the top level.
 *
 * A loose regex is unsafe here: a nested or duplicate response key can be
 * selected for signature verification while JSON.parse() later consumes a
 * different value (JSON.parse keeps the last duplicate key).  Walk only the
 * top-level object, reject duplicate keys, and require the signed response
 * value to be an object so the bytes verified are the bytes consumed by the
 * caller.
 */
function topLevelResponseValue(raw, responseKey) {
  let index = skipJsonWhitespace(raw, 0)
  if (raw[index] !== '{') throw new Error('Alipay response root is not an object')
  index += 1
  const seen = new Set()
  let selected

  while (true) {
    index = skipJsonWhitespace(raw, index)
    if (raw[index] === '}') {
      index += 1
      break
    }
    const keyStart = index
    const keyEnd = scanJsonStringEnd(raw, keyStart)
    if (keyEnd < 0) throw new Error('Alipay response object key is malformed')
    let key
    try {
      key = JSON.parse(raw.slice(keyStart, keyEnd))
    } catch {
      throw new Error('Alipay response object key is malformed')
    }
    if (typeof key !== 'string' || seen.has(key)) throw new Error('Alipay response object has duplicate keys')
    seen.add(key)
    index = skipJsonWhitespace(raw, keyEnd)
    if (raw[index] !== ':') throw new Error('Alipay response object is malformed')
    index = skipJsonWhitespace(raw, index + 1)
    const valueStart = index
    const valueEnd = scanJsonValueEnd(raw, valueStart)
    if (valueEnd <= valueStart) throw new Error('Alipay response object value is malformed')
    if (key === responseKey) {
      if (raw[valueStart] !== '{') throw new Error('Alipay response value is not an object')
      selected = raw.slice(valueStart, valueEnd)
    }
    index = skipJsonWhitespace(raw, valueEnd)
    if (raw[index] === ',') {
      index += 1
      continue
    }
    if (raw[index] === '}') {
      index += 1
      break
    }
    throw new Error('Alipay response object is malformed')
  }

  if (skipJsonWhitespace(raw, index) !== raw.length) throw new Error('Alipay response has trailing data')
  if (!selected) throw new Error('Alipay response object is not present in raw payload')
  return selected
}

/**
 * Extract the exact response object bytes Alipay signs from a v2 JSON body.
 * JSON.parse + JSON.stringify is not safe here because escaping and key order
 * are part of the signed bytes.
 */
export function responseSignContent(raw, method) {
  const parsed = JSON.parse(raw)
  const preferred = `${String(method).replaceAll('.', '_')}_response`
  const responseKey = Object.prototype.hasOwnProperty.call(parsed, preferred)
    ? preferred
    : Object.prototype.hasOwnProperty.call(parsed, 'error_response') ? 'error_response' : ''
  if (!responseKey) throw new Error('Alipay response payload has no response object')
  return topLevelResponseValue(raw, responseKey)
}

export function verifyResponseSignature(raw, method, publicKey) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  const signature = typeof parsed.sign === 'string' ? parsed.sign : ''
  if (!signature) return false
  try {
    const content = responseSignContent(raw, method)
    return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(publicKey, signature, 'base64')
  } catch {
    return false
  }
}

/**
 * Bind a signed provider response to the order that was requested.  Alipay
 * may omit order fields for a not-found query (an empty object is therefore
 * accepted), but any response carrying trade identity must carry the exact
 * requested merchant order number.
 */
export function responseMatchesOrder(response, orderId) {
  const expected = typeof orderId === 'string' ? orderId.trim() : ''
  if (!expected || !response || typeof response !== 'object' || Array.isArray(response)) return false
  const returned = response.out_trade_no
  if (returned !== undefined && returned !== null && String(returned) !== '') return String(returned) === expected
  if (Object.keys(response).length === 0) return true
  // Error response objects can legitimately omit an order number; a success
  // object may not.  Reject any response carrying trade identity or a
  // success code without the requested order binding.
  if (['trade_no', 'trade_status', 'total_amount'].some(key => response[key] !== undefined && response[key] !== null && String(response[key]) !== '')) return false
  return String(response.code ?? '') !== '10000'
}
