// This metadata is presentation-only. It must never become an actor, member
// lookup alias, identity key, role, or authorization scope.
const maxLoginBytes = 512
const maxLoginCodePoints = 256
const maxEncodedLength = Math.ceil(maxLoginBytes * 4 / 3)

function invalid(): never { throw new Error('OIDC_DISPLAY_LOGIN_INVALID') }

function validateLogin(login: string): void {
  if (typeof login !== 'string' || !login || login !== login.trim()
    || Buffer.byteLength(login, 'utf8') > maxLoginBytes
    || [...login].length > maxLoginCodePoints
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(login)
    || Buffer.from(login, 'utf8').toString('utf8') !== login) invalid()
}

/** Preserve the authenticated provider's text; do not normalize identity names. */
export function encodeOidcDisplayLogin(login: string): string {
  validateLogin(login)
  return Buffer.from(login, 'utf8').toString('base64url')
}

/**
 * Legacy signatures are accepted only when BOTH extension headers are absent.
 * v2 binds the encoded login and a version domain separator to the entire old
 * proof. Invalid/partial extensions never fall back to the legacy signature.
 * This constructs signed bytes; the caller MUST verify the HMAC before using
 * displayAccountLogin. Base64url is transport encoding, not anonymization.
 */
export function bindOidcDisplayLoginProof(legacyCanonical: string, version: unknown, encodedLogin: unknown): { canonical: string; displayAccountLogin?: string } {
  if (version === undefined && encodedLogin === undefined) return { canonical: legacyCanonical }
  if (version !== '2' || typeof encodedLogin !== 'string' || !encodedLogin
    || encodedLogin.length > maxEncodedLength || !/^[A-Za-z0-9_-]+$/u.test(encodedLogin)) invalid()
  const login = Buffer.from(encodedLogin, 'base64url').toString('utf8')
  // Node's decoder accepts padding/trailing bits and replaces malformed UTF-8.
  // Exact round-trip is required so there is only one wire form per value.
  if (encodeOidcDisplayLogin(login) !== encodedLogin) invalid()
  return { canonical: `oidc-v2\n${legacyCanonical}\n${encodedLogin}`, displayAccountLogin: login }
}
