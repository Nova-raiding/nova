import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTROLS, parseInstallArguments, prepareControlBytes } from '../infra/scripts/install-ecs-release-controls.mjs';

const source = Buffer.from('#!/usr/bin/env node\nconsole.log("reviewed control");\n');
const sha = createHash('sha256').update(source).digest('hex');
describe('protected release-control installation', () => {
  it('pins the interpreter while preserving every reviewed body byte', () => {
    expect(prepareControlBytes('backup', source, sha, '/opt/node-v22/bin/node').toString())
      .toBe('#!/opt/node-v22/bin/node\nconsole.log("reviewed control");\n');
  });
  it.each(['../evil', 'constructor', 'toString', 'nonce'])('rejects unknown control %s', control => {
    expect(() => prepareControlBytes(control, source, sha, '/usr/bin/node')).toThrow('unknown release control');
  });
  it('refuses source substitutions', () => {
    expect(() => prepareControlBytes('backup', Buffer.concat([source, Buffer.from('// changed')]), sha, '/usr/bin/node')).toThrow('checksum');
  });
  it.each(['node', '/tmp/../usr/bin/node', '/usr/bin/node --eval bad', '/usr//bin/node'])('rejects unsafe runtime %s', node => {
    expect(() => prepareControlBytes('backup', source, sha, node)).toThrow('canonical');
  });
  it('does not accept arbitrary destinations or trust directories', () => {
    expect(Object.keys(CONTROLS).sort()).toEqual(['backup', 'bridge254Review', 'bridge254State', 'bridgeB', 'bundle', 'canonicalAttester', 'canonicalSnapshot', 'capability', 'demo254Backup', 'demo254Plan', 'manual', 'pg17BaselineBackup', 'pg17Plan', 'preidentity', 'restore']);
    expect(CONTROLS.demo254Backup).toEqual({ executable: 'attest-demo-254-backup', digest: 'production-demo-254-backup-attester-sha256' });
    expect(CONTROLS.demo254Plan).toEqual({ executable: 'attest-demo-254-frozen-plan', digest: 'production-demo-254-plan-signer-sha256' });
    expect(CONTROLS.pg17Plan).toEqual({ executable: 'attest-pg17-frozen-plan', digest: 'production-pg17-plan-signer-sha256' });
    expect(CONTROLS.pg17BaselineBackup).toEqual({ executable: 'attest-pg17-backup-baseline', digest: 'production-pg17-baseline-backup-sha256' });
    expect(CONTROLS.canonicalSnapshot).toEqual({ executable: 'canonical-safe-state-snapshot.mjs', digest: 'canonical-safe-state-library-sha256' });
    expect(CONTROLS.canonicalAttester).toEqual({ executable: 'attest-canonical-safe-state', digest: 'canonical-safe-state-collector-sha256' });
    expect(CONTROLS.bridge254Review).toEqual({ executable: 'ecs-bridge-254-review-state.mjs', digest: 'production-bridge-254-review-state-sha256' });
    expect(CONTROLS.bridge254State).toEqual({ executable: 'ecs-bridge-254-state-store.mjs', digest: 'production-bridge-254-state-store-sha256' });
    expect(CONTROLS.bridgeB).toEqual({ executable: 'ecs-bridge-b-transition', digest: 'production-bridge-b-transition-sha256' });
    expect(prepareControlBytes('bridgeB', source, sha, '/usr/bin/node').toString())
      .toBe('#!/usr/bin/node\nconsole.log("reviewed control");\n');
    expect(() => parseInstallArguments(['--destination', '/tmp/evil'])).toThrow();
  });
  it('requires all exact non-duplicated CLI arguments', () => {
    const args = ['--control', 'backup', '--source', '/source.mjs', '--source-sha256', sha, '--node', '/usr/bin/node', '--node-sha256', sha];
    expect(parseInstallArguments(args)['--control']).toBe('backup');
    expect(() => parseInstallArguments([...args.slice(0, 8), '--control', 'backup'])).toThrow('duplicate');
  });
  it('retains old controls and does not provision signing keys or run deployment', () => {
    const text = readFileSync('infra/scripts/install-ecs-release-controls.mjs', 'utf8');
    expect(text).toContain('control-install-history');
    expect(text).toContain('O_NOFOLLOW');
    expect(text).toContain('previous_sha256');
    expect(text).not.toContain('generateKeyPair');
    expect(text).not.toContain('docker compose');
    expect(execFileSync(process.execPath, ['--check', 'infra/scripts/install-ecs-release-controls.mjs'], { encoding: 'utf8' })).toBe('');
  });
});
