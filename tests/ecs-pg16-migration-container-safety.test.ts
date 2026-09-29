import { describe, expect, it } from 'vitest'
import { PG16_MIGRATION_CONTAINER_IMAGE, PG16_MIGRATION_DATA_PATH, PG16_MIGRATION_LABEL_PREFIX, PG16_MIGRATION_PURPOSE, verifyPg16MigrationContainer, type Pg16MigrationContainerIdentity } from './ecs-pg16-migration-container-safety.js'

const expected = { id: 'a'.repeat(64), name: 'merchant-pg16-migration-run', runId: 'run-uuid', imageId: 'sha256:' + 'b'.repeat(64), running: true }
function fixture(): Pg16MigrationContainerIdentity {
  return {
    id: expected.id,
    name: `/${expected.name}`,
    image: PG16_MIGRATION_CONTAINER_IMAGE,
    imageId: expected.imageId,
    labels: { [`${PG16_MIGRATION_LABEL_PREFIX}.purpose`]: PG16_MIGRATION_PURPOSE, [`${PG16_MIGRATION_LABEL_PREFIX}.run-id`]: expected.runId },
    autoRemove: true,
    running: true,
    tmpfs: { [PG16_MIGRATION_DATA_PATH]: 'rw,noexec,nosuid,size=512m' },
    mounts: [],
    ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] },
  }
}

describe('PG16 migration temporary container identity gate', () => {
  it('accepts only its fixed image, owned labels, auto-remove, tmpfs, no mounts and loopback port', () => {
    expect(() => verifyPg16MigrationContainer(fixture(), expected)).not.toThrow()
  })

  it.each([
    ['container id', (item: Pg16MigrationContainerIdentity) => { item.id = 'c'.repeat(64) }],
    ['image', (item: Pg16MigrationContainerIdentity) => { item.image = 'postgres:16' }],
    ['image id', (item: Pg16MigrationContainerIdentity) => { item.imageId = 'sha256:' + 'c'.repeat(64) }],
    ['purpose label', (item: Pg16MigrationContainerIdentity) => { item.labels![`${PG16_MIGRATION_LABEL_PREFIX}.purpose`] = 'other' }],
    ['run label', (item: Pg16MigrationContainerIdentity) => { item.labels![`${PG16_MIGRATION_LABEL_PREFIX}.run-id`] = 'another-run' }],
    ['auto remove', (item: Pg16MigrationContainerIdentity) => { item.autoRemove = false }],
    ['tmpfs', (item: Pg16MigrationContainerIdentity) => { item.tmpfs = {} }],
    ['executable tmpfs', (item: Pg16MigrationContainerIdentity) => { item.tmpfs![PG16_MIGRATION_DATA_PATH] = 'rw,nosuid,size=512m' }],
    ['unbounded tmpfs', (item: Pg16MigrationContainerIdentity) => { item.tmpfs![PG16_MIGRATION_DATA_PATH] = 'rw,noexec,nosuid' }],
    ['host mount', (item: Pg16MigrationContainerIdentity) => { item.mounts.push({ Type: 'bind', Destination: '/var/lib/postgresql/data' }) }],
    ['non-loopback port', (item: Pg16MigrationContainerIdentity) => { item.ports['5432/tcp']![0]!.HostIp = '0.0.0.0' }],
    ['extra port', (item: Pg16MigrationContainerIdentity) => { item.ports['5433/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '32769' }] }],
    ['invalid port', (item: Pg16MigrationContainerIdentity) => { item.ports['5432/tcp']![0]!.HostPort = '65536' }],
  ])('rejects unsafe %s evidence', (_case, mutate) => {
    const item = fixture()
    mutate(item)
    expect(() => verifyPg16MigrationContainer(item, expected)).toThrow('PG16_ISOLATED_CONTAINER_IDENTITY_MISMATCH')
  })
})
