export type PlatformAuthorizationReply = { mode: string; authorizationUrl?: string }

export type PlatformAuthorizationStart =
  | { status: 'popup_blocked' }
  | { status: 'pending'; popup: Window; result: Promise<PlatformAuthorizationReply> }

/**
 * Open a blank tab synchronously in the click handler, before starting the API
 * request. `noopener` as a window.open feature would hide the WindowProxy, so
 * sever the reverse opener link on the returned same-origin blank page instead
 * and set a no-referrer policy before it navigates away.
 */
export function startPlatformAuthorization(
  openWindow: (url: string, target: string) => Window | null,
  authorize: () => Promise<PlatformAuthorizationReply>,
): PlatformAuthorizationStart {
  const popup = openWindow('about:blank', '_blank')
  if (!popup) return { status: 'popup_blocked' }
  try {
    popup.opener = null
    const referrerPolicy = popup.document.createElement('meta')
    referrerPolicy.name = 'referrer'
    referrerPolicy.content = 'no-referrer'
    popup.document.head.appendChild(referrerPolicy)
  } catch (error) {
    popup.close()
    throw error
  }
  let result: Promise<PlatformAuthorizationReply>
  try {
    result = authorize()
  } catch (error) {
    popup.close()
    throw error
  }
  return {
    status: 'pending',
    popup,
    result: result.catch(error => {
      popup.close()
      throw error
    }),
  }
}

/** Only navigate the pre-opened tab to a server-issued HTTPS consent URL. */
export function navigatePlatformAuthorization(popup: Window, authorizationUrl: string): void {
  let target: URL
  try { target = new URL(authorizationUrl) } catch { throw new Error('官方授权地址格式无效') }
  if (target.protocol !== 'https:' || !target.hostname || target.username || target.password) {
    throw new Error('官方授权地址未通过安全校验')
  }
  popup.location.replace(target.toString())
}
