import test from 'node:test'
import assert from 'node:assert/strict'
import * as planControl from './attest-pg17-frozen-plan.mjs'

function productionPostgresInspection() {
  return {
    Id: 'a'.repeat(64), Name: '/merchant-production-postgres-1', State: { Running: true },
    Config: {
      Image: 'postgres:16-alpine',
      Labels: { 'com.docker.compose.project': 'merchant-production', 'com.docker.compose.service': 'postgres' },
      Env: ['POSTGRES_DB=merchant', 'POSTGRES_USER=merchant', 'POSTGRES_PASSWORD=secret'],
    },
    NetworkSettings: { Networks: { 'merchant-production_default': { IPAddress: '172.29.0.2' } } },
  }
}

test('plan inspector fixes its Docker daemon and rejects hostile ambient selectors', () => {
  planControl.assertLocalDockerTarget({})
  planControl.assertLocalDockerTarget({ DOCKER_HOST: 'unix:///var/run/docker.sock' })
  for (const environment of [
    { DOCKER_CONTEXT: 'remote' },
    { DOCKER_CONFIG: '/tmp/attacker' },
    { DOCKER_HOST: 'tcp://docker.example:2376' },
  ]) assert.throws(() => planControl.assertLocalDockerTarget(environment), /Docker target is forbidden/u)
  let invocation
  const source = planControl.inspectProductionPostgres({
    environment: {},
    run: (...args) => { invocation = args; return JSON.stringify([productionPostgresInspection()]) },
  })
  assert.equal(source.networkHost, '172.29.0.2')
  assert.deepEqual(invocation[1], ['--host', 'unix:///var/run/docker.sock', 'inspect', 'merchant-production-postgres-1'])
  assert.deepEqual(invocation[2].env, { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' })
})

test('plan inspector rejects substituted name, image, labels, and network', () => {
  const valid = productionPostgresInspection()
  for (const mutate of [
    value => { value.Name = '/candidate-postgres-1' },
    value => { value.Config.Image = 'postgres:17-alpine' },
    value => { value.Config.Labels['com.docker.compose.project'] = 'candidate' },
    value => { value.Config.Labels['com.docker.compose.service'] = 'postgres-copy' },
    value => { value.NetworkSettings.Networks = { candidate_default: { IPAddress: '172.29.0.2' } } },
  ]) {
    const substituted = structuredClone(valid)
    mutate(substituted)
    assert.throws(() => planControl.validateProductionPostgresInspection(substituted), /identity mismatch|network ambiguous/u)
  }
})

test('protected plan control has no caller-directed signing capability', async () => {
  assert.equal(typeof planControl.signFrozenPlanFromObservedCatalog, 'undefined')
  const selfApprovedArguments = [
    'sign', '--release-id', 'release-39fc097d-review', '--git-sha', '1'.repeat(40),
    '--attempt-id', 'attempt-self-approved', '--approved-policy-sha256', 'a'.repeat(64),
    '--approved-table-plan-sha256', 'b'.repeat(64),
  ]
  await assert.rejects(planControl.runProtectedPlanSigner(selfApprovedArguments),
    /plan signing is disabled until independent owner approval is provisioned/u)
})
