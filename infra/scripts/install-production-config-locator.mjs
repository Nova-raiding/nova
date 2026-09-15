#!/usr/bin/env node
// Install only the reviewed locator-loading block into an older deployment
// checkout. Back up first; do not replace unrelated deployment changes.
import { readFileSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const [root] = process.argv.slice(2);
if (!root) process.exit(1);
try {
  const locator = resolve(root, '.env.production-config-path');
  const config = readFileSync(locator, 'utf8').split(/\r?\n/)[0].trim();
  if (!config.startsWith(`${resolve(root)}/`) || !existsSync(config)) throw new Error();
  const entry = resolve(root, 'infra/scripts/launch-preflight.sh');
  const before = readFileSync(entry, 'utf8');
  const marker = 'config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}';
  const block = String.raw`
if [ -z "$config_path" ] && [ -f "$root/.env.production-config-path" ]; then
  IFS= read -r config_path < "$root/.env.production-config-path" || [ -n "$config_path" ]
fi
case "$config_path" in
  ''|/*) ;;
  *) config_path="$root/$config_path" ;;
esac
export PRODUCTION_CONFIG_PATH="$config_path"`;
  if (before.includes(marker + block)) {
    console.log('production config locator already supported');
  } else {
    if (before.split(marker).length !== 2) throw new Error();
    const backup = resolve(root, 'deploy/production-config/launch-preflight.before-locator.sh');
    writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
    const temp = `${entry}.config-locator-${process.pid}.tmp`;
    writeFileSync(temp, before.replace(marker, marker + block), { mode: statSync(entry).mode & 0o777, flag: 'wx' });
    if (readFileSync(entry, 'utf8') !== before) throw new Error();
    renameSync(temp, entry);
    console.log('production config locator installed; previous entrypoint backed up');
  }
} catch {
  console.error('production config locator installation blocked; inspect target privately');
  process.exitCode = 1;
}
