import Credential, { Config } from '@alicloud/credentials'

type AliyunCredential = {
  accessKeyId?: string
  accessKeySecret?: string
  securityToken?: string
}

type AliyunCredentialClient = { getCredential(): Promise<AliyunCredential> }

export function createAliyunEcsRoleCredentials(
  roleName: string,
  createClient: (config: Config) => AliyunCredentialClient = config => new Credential.default(config),
) {
  const normalizedRoleName = roleName.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalizedRoleName)) throw new Error('ASSET_STORAGE_ECS_RAM_ROLE_INVALID')
  const client = createClient(new Config({
    type: 'ecs_ram_role',
    roleName: normalizedRoleName,
    disableIMDSv1: true,
    asyncCredentialUpdateEnabled: true,
    connectTimeout: 1_000,
    timeout: 2_000,
  }))
  return async () => {
    const value = await client.getCredential()
    const accessKeyId = value.accessKeyId?.trim()
    const secretAccessKey = value.accessKeySecret?.trim()
    const sessionToken = value.securityToken?.trim()
    if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error('ALIYUN_ECS_RAM_ROLE_CREDENTIALS_INVALID')
    return { accessKeyId, secretAccessKey, sessionToken }
  }
}
