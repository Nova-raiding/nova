#!/usr/bin/env node
// Prepare configuration on the deployment host. Never exports raw credentials,
// invents secret references, evaluates dotenv, or changes runtime services.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [source, output, gate, locator] = process.argv.slice(2);
if (!source || !output || !gate) {
  console.error('usage: render-production-config-from-env.mjs ENV OUTPUT GATE [LOCATOR]');
  process.exit(1);
}
try {
  const contract = readFileSync(gate, 'utf8').match(/^required_keys='([^']+)'/m)?.[1];
  if (!contract) throw new Error('missing contract');
  const requiredKeys = [...new Set([...contract.split(/\s+/), 'mcp_authorization_mode', 'durable_platform_assignments_required', 'platform_operations_mode',
    'app_base_url', 'ops_base_url', 'mcp_base_url', 'asset_scan_trusted_public_keys_ref',
    'OPS_AUTH_MODE', 'object_storage_sse_mode', 'release_id'])];
  const aliases = {
    object_storage_bucket: 'ASSET_STORAGE_BUCKET', object_storage_region: 'ASSET_STORAGE_REGION',
    object_storage_endpoint: 'ASSET_STORAGE_ENDPOINT', object_storage_sse_mode: 'ASSET_STORAGE_SSE_MODE',
    maximum_task_cost_cny: 'MODEL_MAX_TASK_COST_CNY',
    mcp_authorization_mode: 'MCP_AUTHZ_MODE',
    durable_platform_assignments_required: 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED',
    app_base_url: 'PUBLIC_APP_BASE_URL',
  };
  const socialGroups = ['xiaohongshu', 'douyin'].map(platform =>
    ['auth', 'read', 'write'].map(capability => `${platform}_${capability}_enabled`));
  const optionalKeys = ['alert_channel_secret_ref', 'object_storage_kms_key', ...socialGroups.flat()];
  const allKeys = [...requiredKeys, ...optionalKeys];
  const wanted = new Set(allKeys.flatMap(key => [key.toUpperCase(), aliases[key]].filter(Boolean)));
  const values = new Map();
  for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    if (values.has(match[1])) throw new Error('ambiguous environment');
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.lastIndexOf(quote);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw new Error('invalid environment quoting');
      // Do not interpret shell escapes, expansions, or command substitutions.
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    values.set(match[1], value);
  }
  const resolved = new Map(allKeys.map(key => {
    const primary = values.get(key.toUpperCase()), alias = values.get(aliases[key]);
    if (primary !== undefined && alias !== undefined && primary !== alias) throw new Error('conflicting environment aliases');
    return [key, primary ?? alias];
  }));
  const required = new Set(requiredKeys);
  if (resolved.get('alert_notifications_enabled') === 'true') required.add('alert_channel_secret_ref');
  if (resolved.get('object_storage_sse_mode') === 'aws:kms') required.add('object_storage_kms_key');
  const enabledSocial = new Set();
  for (const group of socialGroups) if (group.some(key => resolved.get(key) === 'true')) {
    for (const key of group) { required.add(key); enabledSocial.add(key); }
  }
  // Only these legacy grep contracts require an unquoted scalar. Preserve
  // JSON quoting for other strings, and reject YAML syntax in plain values.
  const plainKeys = new Set(['OPS_AUTH_MODE', 'session_id_hash_secret_ref', 'secret_provider',
    'merchant_ui_api_token_ref', 'merchant_ui_workspace_id_ref', 'payment_checkout_base_url',
    'payment_provider_checkout_api_url', 'payment_provider_query_api_url', 'payment_provider_refund_query_api_url',
    'payment_provider_refund_api_url', 'payment_callback_base_url', 'payment_provider_api_key_ref',
    'payment_provider_merchant_id', 'payment_callback_secret_ref', 'platform_rule_sync_signing_secret_ref',
    'asset_display_url_signing_secret_ref']);
  const missing = [];
  const entries = allKeys.flatMap(key => {
    const value = resolved.get(key);
    const invalid = !value || /^(?:null|~)$/i.test(value) || /\$\{|\$\(|`|SET_[A-Z_]+|BLOCKED_UNTIL_|\b(?:REPLACE_ME|CHANGE_ME|TODO|TBD)\b|localhost|127\.0\.0\.1|example\.com/i.test(value)
      || (enabledSocial.has(key) && value !== 'true')
      || (plainKeys.has(key) && !/^[A-Za-z0-9_./][A-Za-z0-9._:/@%?&=+~#-]*$/.test(value));
    if (invalid) {
      if (!required.has(key)) return [];
      missing.push(key); return [`${key}: null`];
    }
    const numeric = /(?:_days|_hours|_minutes|_bytes|_connections|_percent|_per_minute|_cost_cny)$/.test(key);
    const scalar = plainKeys.has(key) || /^(true|false)$/.test(value) || (numeric && /^\d+(?:\.\d+)?$/.test(value)) ? value : JSON.stringify(value);
    return [`${key}: ${scalar}`];
  });
  const status = missing.length ? 'BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS' : 'REQUIRES_RUNTIME_RELEASE_VERIFICATION';
  writeFileSync(output, `# Prepared from deployment environment; no raw credentials exported.\nconfiguration_status: ${status}\n${entries.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  if (locator) writeFileSync(locator, `${resolve(output)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ written: true, locatorWritten: Boolean(locator), ready: false, missingKeys: missing }));
  process.exitCode = missing.length ? 2 : 0;
} catch {
  // Parser/filesystem errors may contain sensitive input: never echo them.
  console.error('production config preparation failed; source or output is invalid or already exists');
  process.exitCode = 1;
}
