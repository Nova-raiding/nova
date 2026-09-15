import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('server-side production config preparation', () => {
  it('patches only the locator block, backs up the old launcher and is idempotent', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'production-install-'));
    try {
      mkdirSync(resolve(root, 'infra/scripts'), { recursive: true });
      mkdirSync(resolve(root, 'deploy/production-config'), { recursive: true });
      const config = resolve(root, 'deploy/production-config/production.yaml');
      writeFileSync(config, 'configuration_status: BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS\n');
      writeFileSync(resolve(root, '.env.production-config-path'), `${config}\n`);
      const entry = resolve(root, 'infra/scripts/launch-preflight.sh');
      const original = '#!/bin/sh\nset -eu\nroot="unchanged"\nconfig_path=${1:-${PRODUCTION_CONFIG_PATH:-}}\n# .env.production-config-path not supported yet\n# keep custom deployment code\n';
      writeFileSync(entry, original, { mode: 0o755 });
      const run = () => spawnSync(process.execPath, ['infra/scripts/install-production-config-locator.mjs', root], { encoding: 'utf8' });
      expect(run().status).toBe(0);
      const after = readFileSync(entry, 'utf8');
      expect(after).toContain('IFS= read -r config_path');
      expect(after).toContain('# keep custom deployment code');
      expect(statSync(entry).mode & 0o777).toBe(0o755);
      expect(readFileSync(resolve(root, 'deploy/production-config/launch-preflight.before-locator.sh'), 'utf8')).toBe(original);
      expect(run().status).toBe(0);
      expect(readFileSync(entry, 'utf8')).toBe(after);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('exports only explicit configuration, blocks missing references, and never evaluates dotenv', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'production-render-'));
    try {
      const env = resolve(dir, 'source.env'), output = resolve(dir, 'production.yaml'), locator = resolve(dir, 'locator');
      writeFileSync(env, 'PAYMENT_MODE=provider\nMODEL_RELAY_API_KEY=private-credential\nMODEL_RELAY_API_KEY_REF=null\nMODEL_RELAY_BASE_URL="https://relay.example.test/v1"\nASSET_STORAGE_BUCKET=real-bucket\nPLUGIN_ENABLED=$(touch should-never-exist)\nAPP_BASE_URL=https://localhost\n');
      const run = () => spawnSync(process.execPath, ['infra/scripts/render-production-config-from-env.mjs', env, output, 'infra/scripts/validate-production-config.sh', locator], { encoding: 'utf8' });
      const result = run();
      expect(result.status).toBe(2);
      const config = readFileSync(output, 'utf8');
      expect(config).toContain('payment_mode: "provider"');
      expect(config).toContain('object_storage_bucket: "real-bucket"');
      expect(config).toContain('model_relay_api_key_ref: null');
      expect(config).toContain('BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS');
      expect(config + result.stdout + result.stderr).not.toContain('private-credential');
      expect(config).not.toContain('touch');
      expect(readFileSync(locator, 'utf8')).toBe(`${output}\n`);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(run().status).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe(config);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
