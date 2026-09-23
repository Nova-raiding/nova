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
    expect(Object.keys(CONTROLS).sort()).toEqual(['backup', 'bridgeB', 'bundle', 'capability', 'manual', 'preidentity', 'restore']);
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
