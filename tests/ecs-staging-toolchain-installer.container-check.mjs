// Run only in a disposable network-isolated container as root. The candidate
// archive is read-only input; all installation writes stay inside this test VM.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

assert(existsSync('/.dockerenv'), 'isolated container required');
assert.equal(process.getuid(), 0, 'root-owned path rehearsal required');
assert.deepEqual((await import('node:fs')).readdirSync('/sys/class/net'), ['lo'], 'network-disabled container required');
const sourceRoot = realpathSync('/source');
const bundle = process.argv[2] ?? '/source/artifacts/deployment-candidates/ecs-20260924T055433Z';
const controlRoot = '/srv/release-candidates';
const lockDir = '/var/lib/merchant-release-security/locks';
const fixedNode = '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node';
const installerSource = `${sourceRoot}/infra/scripts/install-ecs-staging-toolchain.mjs`;
const hash = value => createHash('sha256').update(value).digest('hex');
const bootstrapSha = hash(readFileSync(installerSource));
const installer = `${controlRoot}/install-ecs-staging-toolchain.${bootstrapSha}.mjs`;

mkdirSync('/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin', { recursive: true, mode: 0o755 });
copyFileSync(process.execPath, fixedNode); chmodSync(fixedNode, 0o755);
mkdirSync(controlRoot, { recursive: true, mode: 0o700 }); chmodSync(controlRoot, 0o700);
mkdirSync(lockDir, { recursive: true, mode: 0o700 }); chmodSync(lockDir, 0o700);
const sharedLock = `${lockDir}/ecs-source-build.lock`;
writeFileSync(sharedLock, '', { mode: 0o600 }); chmodSync(sharedLock, 0o600);
copyFileSync(installerSource, installer); chmodSync(installer, 0o600);

// These tiny test adapters provide only the tar operations needed by the
// installer. Archive SHA, identity and Git archive commit are still checked.
writeFileSync('/usr/bin/git', `#!/bin/sh
[ "$1" = get-tar-commit-id ] || exit 2
dd bs=512 skip=1 count=1 2>/dev/null | sed -nE 's/^[0-9]+ comment=([a-f0-9]{40})$/\\1/p'
`, { mode: 0o755 }); chmodSync('/usr/bin/git', 0o755);
writeFileSync('/usr/bin/python3', `#!/bin/sh
[ "$1" = -c ] || exit 2
archive=$3; first=$4; second=$5
a=$(tar -xOf "$archive" "$first" | base64 | tr -d '\\n') || exit 2
b=$(tar -xOf "$archive" "$second" | base64 | tr -d '\\n') || exit 2
printf '{"%s":"%s","%s":"%s"}\\n' "$first" "$a" "$second" "$b"
`, { mode: 0o755 }); chmodSync('/usr/bin/python3', 0o755);
for (const tool of ['shasum', 'npm']) {
  writeFileSync(`/usr/bin/${tool}`, tool === 'npm' ? '#!/bin/sh\nprintf "10.9.4\\n"\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(`/usr/bin/${tool}`, 0o755);
}
if (!existsSync('/usr/bin/tar')) execFileSync('/bin/ln', ['-s', '/bin/tar', '/usr/bin/tar']);

const archive = `${controlRoot}/candidate-source.tar`;
const identity = `${controlRoot}/candidate-identity.txt`;
copyFileSync(`${bundle}/candidate-source.tar`, archive);
copyFileSync(`${bundle}/candidate-identity.txt`, identity);
chmodSync(archive, 0o600); chmodSync(identity, 0o600);
const identityText = readFileSync(identity, 'utf8');
const gitSha = /^git_sha=([a-f0-9]{40})$/m.exec(identityText)?.[1];
assert(gitSha, 'real candidate identity must contain git_sha');

// Model the stale root-owned standalone helper currently found on 101.
const entrypoint = `${controlRoot}/stage-verified-ecs-release.sh`;
writeFileSync(entrypoint, '#!/bin/sh\necho stale-helper\n', { mode: 0o700 });
chmodSync(entrypoint, 0o700);
const args = [installer, 'install', archive, identity, controlRoot, bootstrapSha];
const install = spawnSync(fixedNode, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.equal(install.status, 0, install.stderr);
const receipt = JSON.parse(install.stdout);
assert.equal(receipt.git_sha, gitSha);
assert.equal(receipt.source_archive_sha256, /^source_sha256=sha256:([a-f0-9]{64})$/m.exec(identityText)?.[1]);
assert.equal(receipt.previous_git_sha, null);

const generation = `${controlRoot}/staging-toolchain/versions/${gitSha}`;
const staged = `${generation}/infra/scripts/stage-verified-ecs-release.sh`;
const lock = `${generation}/infra/scripts/ecs-build-lock.sh`;
assert.equal(statSync(staged).uid, 0);
assert.equal(statSync(staged).mode & 0o777, 0o555);
assert.equal(statSync(lock).uid, 0);
assert.equal(statSync(lock).mode & 0o777, 0o444);
assert.equal(hash(readFileSync(staged)), receipt.staging_helper_sha256);
assert.equal(hash(readFileSync(lock)), receipt.build_lock_sha256);
assert.equal(execFileSync('/usr/bin/readlink', ['-f', `${controlRoot}/staging-toolchain/current/infra/scripts/stage-verified-ecs-release.sh`], { encoding: 'utf8' }).trim(), staged);

// The fixed dispatcher must resolve to the generation root, source the paired
// helper, and fail at the candidate-input gate before any npm/build action.
const launched = spawnSync('/bin/sh', [entrypoint], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ECS_CANDIDATE_BUNDLE_DIR: `${controlRoot}/missing`, ECS_RELEASES_ROOT: '/srv/merchant-releases', RELEASE_ID: 'probe' } });
assert.notEqual(launched.status, 0);
assert.match(launched.stderr, /candidate bundle must be a non-symlink directory/);

const contended = spawnSync('/usr/bin/flock', ['-n', sharedLock, '/bin/sh', '-c', `exec ${fixedNode} ${installer} install ${archive} ${identity} ${controlRoot} ${bootstrapSha}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.notEqual(contended.status, 0, 'installer must refuse a build already holding the shared lock');
assert.match(contended.stderr, /another staging\/build operation holds the shared lock/);

const tampered = `${controlRoot}/tampered-identity.txt`;
writeFileSync(tampered, identityText.replace(/source_sha256=sha256:[a-f0-9]{64}/, `source_sha256=sha256:${'0'.repeat(64)}`), { mode: 0o600 });
const rejected = spawnSync(fixedNode, [installer, 'install', archive, tampered, controlRoot, bootstrapSha], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.notEqual(rejected.status, 0, 'archive identity substitution must fail');
assert.equal(execFileSync('/usr/bin/readlink', [`${controlRoot}/staging-toolchain/current`], { encoding: 'utf8' }).trim(), `versions/${gitSha}`);

const secondBundle = process.argv[3] ?? '/source/artifacts/deployment-candidates/ecs-3d9ed18e';
const secondArchive = `${controlRoot}/candidate-second-source.tar`;
const secondIdentity = `${controlRoot}/candidate-second-identity.txt`;
copyFileSync(`${secondBundle}/candidate-source.tar`, secondArchive);
copyFileSync(`${secondBundle}/candidate-identity.txt`, secondIdentity);
chmodSync(secondArchive, 0o600); chmodSync(secondIdentity, 0o600);
const secondSha = /^git_sha=([a-f0-9]{40})$/m.exec(readFileSync(secondIdentity, 'utf8'))?.[1];
assert(secondSha && secondSha !== gitSha, 'second reviewed fixture candidate must have a distinct commit identity');
const switched = spawnSync(fixedNode, [installer, 'install', secondArchive, secondIdentity, controlRoot, bootstrapSha], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.equal(switched.status, 0, switched.stderr);
assert.equal(JSON.parse(switched.stdout).previous_git_sha, gitSha);
assert.equal(execFileSync('/usr/bin/readlink', [`${controlRoot}/staging-toolchain/current`], { encoding: 'utf8' }).trim(), `versions/${secondSha}`);
assert.equal(execFileSync('/usr/bin/readlink', [`${controlRoot}/staging-toolchain/previous`], { encoding: 'utf8' }).trim(), `versions/${gitSha}`);
const rollback = spawnSync(fixedNode, [installer, 'rollback', controlRoot, bootstrapSha], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
assert.equal(rollback.status, 0, rollback.stderr);
assert.equal(JSON.parse(rollback.stdout).to_git_sha, gitSha);
assert.equal(execFileSync('/usr/bin/readlink', [`${controlRoot}/staging-toolchain/current`], { encoding: 'utf8' }).trim(), `versions/${gitSha}`);
console.log(`PASS: root-owned /srv staging pair installed from candidate ${gitSha}; fixed dispatcher, SHA binding, lock, permissions and atomic pointer verified`);
