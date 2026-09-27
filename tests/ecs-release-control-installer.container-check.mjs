// Run inside a disposable, network-disabled Node container as root. Never run on a host.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

assert(existsSync('/.dockerenv'), 'isolated container required');
assert(process.getuid() === 0);
assert.deepEqual(readdirSync('/sys/class/net'), ['lo'], 'network-disabled container required');
const hash = data => createHash('sha256').update(data).digest('hex');
const root = '/var/lib/merchant-release-security';
const bin = '/usr/local/libexec/merchant';
const trust = '/run/release-security/evidence-trust';
assert(!existsSync(root), 'refuse existing release-security state');
for (const path of [root, bin, trust, '/reviewed']) mkdirSync(path, { recursive: true, mode: 0o700 });
const runtime = realpathSync(process.execPath);
const fixture = Buffer.from('#!/usr/bin/env node\nconsole.log("isolated-reviewed-fixture");\n');
writeFileSync('/reviewed/control.mjs', fixture, { mode: 0o600, flag: 'wx' });
const installer = '/source/infra/scripts/install-ecs-release-controls.mjs';
const args = [installer, '--control', 'backup', '--source', '/reviewed/control.mjs', '--source-sha256', hash(fixture), '--node', runtime, '--node-sha256', hash(readFileSync(runtime))];
const run = extra => spawnSync(runtime, extra ?? args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
let result = run();
assert.equal(result.status, 0, result.stderr);
const receipt = JSON.parse(result.stdout);
const installed = `${bin}/attest-postgres-backup`;
assert.equal(receipt.previous_sha256, null);
assert.equal(hash(readFileSync(installed)), receipt.installed_sha256);
assert.equal(readFileSync(`${trust}/production-backup-attester-sha256`, 'utf8').trim(), receipt.installed_sha256);
assert.equal(statSync(installed).mode & 0o777, 0o755);
assert.equal(execFileSync(installed, { encoding: 'utf8' }).trim(), 'isolated-reviewed-fixture');
const bad = [...args]; bad[bad.indexOf('--source-sha256') + 1] = '0'.repeat(64);
assert.notEqual(run(bad).status, 0);
assert.equal(hash(readFileSync(installed)), receipt.installed_sha256);
mkdirSync(`${root}/control-install.lock`, { mode: 0o700 });
assert.notEqual(run().status, 0, 'concurrent lock must reject');
assert.equal(hash(readFileSync(installed)), receipt.installed_sha256);
// All data lives in this disposable container. Remove only our empty test lock.
const { rmdirSync } = await import('node:fs');
rmdirSync(`${root}/control-install.lock`);
result = run();
assert.equal(result.status, 0, result.stderr);
assert.equal(JSON.parse(result.stdout).previous_sha256, receipt.installed_sha256);
assert(readdirSync(`${root}/control-install-history`).some(name => name === `attest-postgres-backup-${receipt.installed_sha256}`));
const bridgeSource = '/reviewed/ecs-bridge-b-transition.mjs';
const bridgeBytes = readFileSync('/source/infra/protected/ecs-bridge-b-transition.mjs');
writeFileSync(bridgeSource, bridgeBytes, { mode: 0o600, flag: 'wx' });
const bridgeArgs = [installer, '--control', 'bridgeB', '--source', bridgeSource, '--source-sha256', hash(bridgeBytes), '--node', runtime, '--node-sha256', hash(readFileSync(runtime))];
result = spawnSync(runtime, bridgeArgs, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.equal(result.status, 0, result.stderr);
const bridgeReceipt = JSON.parse(result.stdout);
const bridgeInstalled = `${bin}/ecs-bridge-b-transition`;
const bridgeDigest = `${trust}/production-bridge-b-transition-sha256`;
assert.equal(statSync(bridgeInstalled).mode & 0o777, 0o755);
assert.equal(hash(readFileSync(bridgeInstalled)), bridgeReceipt.installed_sha256);
assert.equal(readFileSync(bridgeDigest, 'utf8').trim(), bridgeReceipt.installed_sha256);
assert.equal(bridgeReceipt.source_sha256, hash(bridgeBytes));
assert.equal(readFileSync(bridgeInstalled, 'utf8').startsWith(`#!${runtime}\n`), true);
assert(!existsSync(`${root}/production-capability-private.pem`), 'installer must not generate keys');
console.log('PASS: real root installation, bridge target/hash/mode, checksum rejection, concurrent lock rejection and old-control archival');
for (const [control, filename, digestName] of [
  ['bridge254Review', 'ecs-bridge-254-review-state.mjs', 'production-bridge-254-review-state-sha256'],
  ['bridge254State', 'ecs-bridge-254-state-store.mjs', 'production-bridge-254-state-store-sha256'],
]) {
  const source = `/source/infra/protected/${filename}`;
  const bytes = readFileSync(source);
  const options = [installer, '--control', control, '--source', source, '--source-sha256', hash(bytes),
    '--node', runtime, '--node-sha256', hash(readFileSync(runtime))];
  const installedResult = run(options);
  assert.equal(installedResult.status, 0, installedResult.stderr);
  const receipt254 = JSON.parse(installedResult.stdout);
  assert.equal(hash(readFileSync(`${bin}/${filename}`)), receipt254.installed_sha256);
  assert.equal(readFileSync(`${trust}/${digestName}`, 'utf8').trim(), receipt254.installed_sha256);
  assert.equal(statSync(`${bin}/${filename}`).mode & 0o777, 0o755);
}
const installedState = await import(`${bin}/ecs-bridge-254-state-store.mjs`);
assert.equal(installedState.BRIDGE_254_PROTECTED_STATE_PATHS.directory, `${root}/bridge-254`);
assert.throws(() => installedState.openProtectedBridge254StateStore(), /protected bridge state requires root|protected ancestor|ENOENT|trust/u);
console.log('PASS: bridge-254 signed state and review verifier install together with independent digest bindings; no trust keys provisioned');
const preidentitySource = '/source/infra/protected/ecs-preidentity-recovery.mjs';
const preidentityBytes = readFileSync(preidentitySource);
const preidentityArgs = [installer, '--control', 'preidentity', '--source', preidentitySource, '--source-sha256', hash(preidentityBytes), '--node', runtime, '--node-sha256', hash(readFileSync(runtime))];
result = run(preidentityArgs);
assert.equal(result.status, 0, result.stderr);
const preidentityReceipt = JSON.parse(result.stdout);
const preidentityHelper = `${bin}/ecs-preidentity-recovery`;
const preidentityDigest = `${trust}/production-preidentity-recovery-sha256`;
assert.equal(hash(readFileSync(preidentityHelper)), preidentityReceipt.installed_sha256);
assert.equal(readFileSync(preidentityDigest, 'utf8').trim(), preidentityReceipt.installed_sha256);
assert.equal(readFileSync(preidentityHelper, 'utf8').split('\n').slice(1).join('\n'), preidentityBytes.toString('utf8').split('\n').slice(1).join('\n'));
const preidentityVerifier = '/source/infra/scripts/verify-ecs-bridge-control-install.mjs';
const verifyPreidentity = () => spawnSync(runtime, [preidentityVerifier, preidentitySource, preidentityHelper, preidentityDigest], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.equal(verifyPreidentity().status, 0);
// Simulate interruption between executable and trust-digest replacement.
writeFileSync(preidentityDigest, `${'0'.repeat(64)}\n`, { mode: 0o444 });
assert.notEqual(verifyPreidentity().status, 0);
result = spawnSync(preidentityHelper, ['capture'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.notEqual(result.status, 0);
assert.match(result.stderr, /self digest mismatch/u);
result = run(preidentityArgs);
assert.equal(result.status, 0, result.stderr);
assert.equal(readFileSync(preidentityDigest, 'utf8').trim(), hash(readFileSync(preidentityHelper)));
assert.equal(verifyPreidentity().status, 0);
assert(readdirSync(`${root}/control-install-history`).some(name => name.startsWith('ecs-preidentity-recovery-')));
console.log('PASS: real root installation, preidentity executable/digest readback, checksum rejection, concurrent lock rejection and old-control archival');
