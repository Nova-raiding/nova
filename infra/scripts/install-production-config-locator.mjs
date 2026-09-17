#!/usr/bin/env node
// Install only the reviewed locator-loading block into an older deployment
// checkout. Back up first; do not replace unrelated deployment changes.
import { readFileSync, writeFileSync, lstatSync, realpathSync, renameSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
const [root] = process.argv.slice(2);
if (!root) process.exit(1);
try {
  const canonicalRoot = realpathSync(resolve(root));
  if (!lstatSync(canonicalRoot).isDirectory()) throw new Error();
  const withinRoot = path => {
    const rel = relative(canonicalRoot, path);
    return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const absent = path => {
    try { lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  };
  const locator = resolve(canonicalRoot, '.env.production-config-path');
  const locatorStat = lstatSync(locator);
  if (!locatorStat.isFile() && !locatorStat.isSymbolicLink()) throw new Error();
  const canonicalLocator = realpathSync(locator);
  if (!withinRoot(canonicalLocator) || !lstatSync(canonicalLocator).isFile()) throw new Error();
  const locatorText = readFileSync(canonicalLocator, 'utf8');
  if (!/^[^\r\n\0]+(?:\r?\n)?$/.test(locatorText)) throw new Error();
  const config = locatorText.replace(/\r?\n$/, '').trim();
  if (!isAbsolute(config) || !withinRoot(realpathSync(config)) || !lstatSync(realpathSync(config)).isFile()) throw new Error();
  const entry = resolve(canonicalRoot, 'infra/scripts/launch-preflight.sh');
  const entryStat = lstatSync(entry);
  if (!entryStat.isFile() || !withinRoot(realpathSync(entry))) throw new Error();
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
  // Refuse partial or duplicate prior patches before any backup/temp writes.
  // Comments mentioning the old locator are deliberately not executable blocks.
  if (before.split(marker).length !== 2 || !before.split(/\r?\n/).includes(marker)) throw new Error();
  const supported = before.includes(marker + block);
  const remainder = supported ? before.replace(marker + block, '') : before;
  const executableLines = remainder.split(/\r?\n/).filter(line => !line.trimStart().startsWith('#'));
  if (executableLines.some(line => /\.env\.production-config-path|IFS= read -r config_path|case "\$config_path" in|export PRODUCTION_CONFIG_PATH="\$config_path"|config_path="\$root\/\$config_path"/.test(line))) throw new Error();
  if (supported) {
    console.log('production config locator already supported');
  } else {
    const backup = resolve(canonicalRoot, 'deploy/production-config/launch-preflight.before-locator.sh');
    const temp = `${entry}.config-locator-${process.pid}.tmp`;
    if (!withinRoot(realpathSync(dirname(backup))) || !absent(backup) || !absent(temp)) throw new Error();
    if (readFileSync(entry, 'utf8') !== before) throw new Error();
    writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
    writeFileSync(temp, before.replace(marker, marker + block), { mode: entryStat.mode & 0o777, flag: 'wx' });
    if (readFileSync(entry, 'utf8') !== before) throw new Error();
    renameSync(temp, entry);
    console.log('production config locator installed; previous entrypoint backed up');
  }
} catch {
  console.error('production config locator installation blocked; inspect target privately');
  process.exitCode = 1;
}
