const DEFAULT_METADATA_BASE_URL = 'http://100.100.100.200/latest'

type FetchLike = typeof fetch

interface AliyunRoleCredentialDocument {
  Code?: string
  AccessKeyId?: string
  AccessKeySecret?: string
  SecurityToken?: string
  Expiration?: string
}

export function aliyunEcsRamRoleCredentialProvider(options: {
  fetchImpl?: FetchLike
  metadataBaseUrl?: string
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = (options.metadataBaseUrl ?? process.env.ALIYUN_ECS_METADATA_BASE_URL ?? DEFAULT_METADATA_BASE_URL).replace(/\/$/u, '')

  return async () => {
    const headers: Record<string, string> = { Metadata: 'true' }
    const tokenResponse = await fetchImpl(`${baseUrl}/api/token`, {
      method: 'PUT',
      headers: { 'X-aliyun-ecs-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null)
    if (tokenResponse?.ok) headers['X-aliyun-ecs-metadata-token'] = await tokenResponse.text()

    const roleResponse = await fetchImpl(`${baseUrl}/meta-data/ram/security-credentials/`, {
      headers,
      signal: AbortSignal.timeout(2_000),
    })
    if (!roleResponse.ok) throw new Error(`ALIYUN_ECS_RAM_ROLE_UNAVAILABLE:${roleResponse.status}`)
    const roleName = (await roleResponse.text()).trim().split('\n')[0]?.trim()
    if (!roleName) throw new Error('ALIYUN_ECS_RAM_ROLE_UNAVAILABLE:empty_role')

    const credentialResponse = await fetchImpl(`${baseUrl}/meta-data/ram/security-credentials/${encodeURIComponent(roleName)}`, {
      headers,
      signal: AbortSignal.timeout(2_000),
    })
    if (!credentialResponse.ok) throw new Error(`ALIYUN_ECS_RAM_ROLE_CREDENTIALS_UNAVAILABLE:${credentialResponse.status}`)
    const document = await credentialResponse.json() as AliyunRoleCredentialDocument
    if (document.Code !== 'Success' || !document.AccessKeyId || !document.AccessKeySecret || !document.SecurityToken) {
      throw new Error('ALIYUN_ECS_RAM_ROLE_CREDENTIALS_INVALID')
    }
    return {
      accessKeyId: document.AccessKeyId,
      secretAccessKey: document.AccessKeySecret,
      sessionToken: document.SecurityToken,
      ...(document.Expiration ? { expiration: new Date(document.Expiration) } : {}),
    }
  }
}
