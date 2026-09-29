export const PG16_MIGRATION_CONTAINER_IMAGE = 'postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
export const PG16_MIGRATION_PURPOSE = 'ecs-pg16-migration-compatibility'
export const PG16_MIGRATION_LABEL_PREFIX = 'merchant.isolated-pg16'
export const PG16_MIGRATION_DATA_PATH = '/var/lib/postgresql/data'

export type Pg16MigrationContainerIdentity = {
  id: string
  name: string
  image: string
  imageId: string
  labels: Record<string, string> | null
  autoRemove: boolean
  running: boolean
  tmpfs: Record<string, string> | null
  mounts: { Type: string; Destination: string }[]
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>
}

export function verifyPg16MigrationContainer(actual: Pg16MigrationContainerIdentity, expected: {
  id: string
  name: string
  runId: string
  imageId?: string
  running: boolean
}): void {
  const portBindings = actual.ports?.['5432/tcp']
  const boundPort = portBindings?.[0]?.HostPort ?? ''
  const dataTmpfsOptions = actual.tmpfs?.[PG16_MIGRATION_DATA_PATH]?.split(',') ?? []
  const publishedPortsValid = Object.entries(actual.ports ?? {}).every(([port, bindings]) =>
    port === '5432/tcp' ? bindings?.length === 1 && bindings[0]?.HostIp === '127.0.0.1'
      && /^\d+$/u.test(bindings[0]?.HostPort ?? '') : bindings == null)
  if (!/^[a-f0-9]{64}$/u.test(expected.id)
    || actual.id !== expected.id
    || actual.name !== `/${expected.name}`
    || actual.image !== PG16_MIGRATION_CONTAINER_IMAGE
    || (expected.imageId !== undefined && actual.imageId !== expected.imageId)
    || actual.labels?.[`${PG16_MIGRATION_LABEL_PREFIX}.purpose`] !== PG16_MIGRATION_PURPOSE
    || actual.labels?.[`${PG16_MIGRATION_LABEL_PREFIX}.run-id`] !== expected.runId
    || actual.autoRemove !== true
    || actual.running !== expected.running
    || !dataTmpfsOptions.includes('rw')
    || !dataTmpfsOptions.includes('noexec')
    || !dataTmpfsOptions.includes('nosuid')
    || !dataTmpfsOptions.includes('size=512m')
    // Docker reports --tmpfs under HostConfig.Tmpfs, not in .Mounts.
    // Requiring an empty regular-mount list proves no host volume was attached.
    || !Array.isArray(actual.mounts)
    || actual.mounts.length !== 0
    || !publishedPortsValid
    || !/^\d+$/u.test(boundPort)
    || Number(boundPort) < 1 || Number(boundPort) > 65535) {
    throw new Error('PG16_ISOLATED_CONTAINER_IDENTITY_MISMATCH')
  }
}
