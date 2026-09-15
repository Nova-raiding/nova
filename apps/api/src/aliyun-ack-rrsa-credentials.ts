import AlibabaCloudCredential, { Config } from '@alicloud/credentials'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types'

const RAM_ROLE_ARN = /^acs:ram::[0-9]+:role\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const OIDC_PROVIDER_ARN = /^acs:ram::[0-9]+:oidc-provider\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const RRSA_TOKEN_ROOT = '/var/run/secrets/ack.alibabacloud.com/rrsa-tokens/'

export type AliyunAckRrsaEnvironment = {
  ALIBABA_CLOUD_ROLE_ARN?: string
  ALIBABA_CLOUD_OIDC_PROVIDER_ARN?: string
  ALIBABA_CLOUD_OIDC_TOKEN_FILE?: string
  ALIBABA_CLOUD_STS_ENDPOINT?: string
}

type AliyunTemporaryCredential = {
  accessKeyId?: string
  accessKeySecret?: string
  securityToken?: string
}

type AliyunCredentialClient = {
  getCredential(): Promise<AliyunTemporaryCredential>
}

export function validateAliyunAckRrsaEnvironment(source: AliyunAckRrsaEnvironment): { roleArn: string; oidcProviderArn: string; oidcTokenFilePath: string; stsEndpoint?: string } {
  const roleArn = source.ALIBABA_CLOUD_ROLE_ARN?.trim() ?? ''
  const oidcProviderArn = source.ALIBABA_CLOUD_OIDC_PROVIDER_ARN?.trim() ?? ''
  const oidcTokenFilePath = source.ALIBABA_CLOUD_OIDC_TOKEN_FILE?.trim() ?? ''
  const stsEndpoint = source.ALIBABA_CLOUD_STS_ENDPOINT?.trim()
  if (!RAM_ROLE_ARN.test(roleArn)) throw new Error('ALIBABA_CLOUD_ROLE_ARN_MISSING_OR_INVALID')
  if (!OIDC_PROVIDER_ARN.test(oidcProviderArn)) throw new Error('ALIBABA_CLOUD_OIDC_PROVIDER_ARN_MISSING_OR_INVALID')
  if (!oidcTokenFilePath.startsWith(RRSA_TOKEN_ROOT) || oidcTokenFilePath.includes('..')) throw new Error('ALIBABA_CLOUD_OIDC_TOKEN_FILE_MISSING_OR_INVALID')
  if (stsEndpoint && (!/^sts(?:-vpc)?\.[a-z0-9-]+\.aliyuncs\.com$/u.test(stsEndpoint))) throw new Error('ALIBABA_CLOUD_STS_ENDPOINT_INVALID')
  return { roleArn, oidcProviderArn, oidcTokenFilePath, ...(stsEndpoint ? { stsEndpoint } : {}) }
}

export function createAliyunAckRrsaCredentials(
  source: AliyunAckRrsaEnvironment = process.env,
  createClient: (config: Config) => AliyunCredentialClient = config => new AlibabaCloudCredential.default(config),
): AwsCredentialIdentityProvider {
  const config = validateAliyunAckRrsaEnvironment(source)
  const credential = createClient(new Config({
    type: 'oidc_role_arn',
    roleArn: config.roleArn,
    oidcProviderArn: config.oidcProviderArn,
    oidcTokenFilePath: config.oidcTokenFilePath,
    ...(config.stsEndpoint ? { stsEndpoint: config.stsEndpoint } : {}),
    roleSessionName: 'store-nova-api',
    roleSessionExpiration: 3_600,
    connectTimeout: 1_000,
    timeout: 2_000,
  }))
  return async (): Promise<AwsCredentialIdentity> => {
    const current = await credential.getCredential()
    const accessKeyId = current.accessKeyId?.trim()
    const secretAccessKey = current.accessKeySecret?.trim()
    const sessionToken = current.securityToken?.trim()
    if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error('ALIYUN_ACK_RRSA_CREDENTIALS_INVALID')
    return { accessKeyId, secretAccessKey, sessionToken }
  }
}
