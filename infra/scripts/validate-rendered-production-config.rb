#!/usr/bin/env ruby
# frozen_string_literal: true

require 'psych'
require 'uri'
require 'ipaddr'

class ProductionManifestBindingError < StandardError; end

def convert_yaml_node(node, path = '$')
  raise ProductionManifestBindingError, "YAML aliases are forbidden at #{path}" if node.respond_to?(:anchor) && node.anchor

  case node
  when Psych::Nodes::Scalar
    node.value
  when Psych::Nodes::Sequence
    node.children.each_with_index.map { |child, index| convert_yaml_node(child, "#{path}[#{index}]") }
  when Psych::Nodes::Mapping
    result = {}
    node.children.each_slice(2) do |key_node, value_node|
      key = convert_yaml_node(key_node, "#{path}.<key>")
      raise ProductionManifestBindingError, "YAML mapping key must be a scalar at #{path}" unless key.is_a?(String)
      raise ProductionManifestBindingError, "duplicate YAML key #{key.inspect} at #{path}" if result.key?(key)
      result[key] = convert_yaml_node(value_node, "#{path}.#{key}")
    end
    result
  when Psych::Nodes::Alias
    raise ProductionManifestBindingError, "YAML aliases are forbidden at #{path}"
  else
    raise ProductionManifestBindingError, "unsupported YAML node at #{path}"
  end
end

def load_yaml_documents(path)
  stream = Psych.parse_stream(File.read(path, encoding: 'UTF-8'))
  stream.children.filter_map.with_index do |document, index|
    next if document.root.nil?
    convert_yaml_node(document.root, "$document[#{index}]")
  end
rescue Psych::SyntaxError, EncodingError => error
  raise ProductionManifestBindingError, "invalid YAML artifact: #{error.message.lines.first&.strip}"
end

def flatten_resources(documents)
  documents.flat_map do |document|
    if document.is_a?(Hash) && document['kind'] == 'List'
      items = document['items']
      raise ProductionManifestBindingError, 'rendered List.items must be an array' unless items.is_a?(Array)
      flatten_resources(items)
    else
      [document]
    end
  end
end

def leaf_values(value, key, observed = [])
  case value
  when Hash
    value.each do |candidate, child|
      observed << child if candidate == key
      leaf_values(child, key, observed)
    end
  when Array
    value.each { |child| leaf_values(child, key, observed) }
  end
  observed
end

def required_config_leaf(config, key)
  values = leaf_values(config, key)
  raise ProductionManifestBindingError, "production config key is missing: #{key}" if values.empty?
  raise ProductionManifestBindingError, "production config key is ambiguous: #{key}" unless values.length == 1
  value = values.first
  raise ProductionManifestBindingError, "production config key must be scalar: #{key}" if value.is_a?(Hash) || value.is_a?(Array) || value.nil?
  value.to_s
end

def require_binding(config, runtime, config_key, runtime_key)
  expected = required_config_leaf(config, config_key)
  actual = runtime[runtime_key]
  raise ProductionManifestBindingError, "merchant-runtime key is missing: #{runtime_key}" if actual.nil?
  raise ProductionManifestBindingError, "production config and rendered manifest mismatch: #{config_key} -> #{runtime_key}" unless actual.to_s == expected
end

def required_config_path(config, flat_key, path)
  candidates = []
  candidates << config[flat_key] if config.key?(flat_key)
  cursor = config
  found = true
  path.each do |segment|
    unless cursor.is_a?(Hash) && cursor.key?(segment)
      found = false
      break
    end
    cursor = cursor[segment]
  end
  candidates << cursor if found
  raise ProductionManifestBindingError, "production config key is missing: #{flat_key}" if candidates.empty?
  raise ProductionManifestBindingError, "production config key is ambiguous: #{flat_key}" unless candidates.length == 1
  value = candidates.first
  raise ProductionManifestBindingError, "production config key must be scalar: #{flat_key}" if value.is_a?(Hash) || value.is_a?(Array) || value.nil?
  value.to_s
end

def canonical_https_url(value, field, origin: false)
  uri = URI.parse(value)
  valid = uri.is_a?(URI::HTTPS) && uri.host && uri.host == uri.host.downcase && uri.userinfo.nil? && uri.query.nil? && uri.fragment.nil?
  valid &&= ['', '/'].include?(uri.path) && value.match?(/\Ahttps:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/?\z/) if origin
  raise ProductionManifestBindingError, "#{field} must be a canonical HTTPS #{origin ? 'origin' : 'URL'}" unless valid
  uri
rescue URI::InvalidURIError
  raise ProductionManifestBindingError, "#{field} must be a canonical HTTPS #{origin ? 'origin' : 'URL'}"
end

def public_hostname?(hostname)
  return false if hostname == 'localhost' || hostname.end_with?('.localhost')
  address = IPAddr.new(hostname)
  !(address.private? || address.loopback? || address.link_local?)
rescue IPAddr::InvalidAddressError
  true
end

def placeholder_hostname?(hostname)
  normalized = hostname.to_s.downcase
  return true if %w[example invalid localhost test].include?(normalized)
  return true if %w[example.com example.net example.org].any? { |domain| normalized == domain || normalized.end_with?(".#{domain}") }

  %w[.example .invalid .localhost .test].any? { |suffix| normalized.end_with?(suffix) }
end

# Payment endpoints require globally routable literal addresses, not only RFC1918 exclusion.
# Keep this stricter policy scoped to payment fields; unrelated URL contracts are unchanged.
def payment_public_hostname?(hostname)
  normalized = hostname.delete_prefix('[').delete_suffix(']')
  address = IPAddr.new(normalized)
  if address.ipv4?
    return false unless normalized == address.to_s
    blocked = %w[0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4]
    return blocked.none? { |network| IPAddr.new(network).include?(address) }
  end
  IPAddr.new('2000::/3').include?(address) && %w[2001::/23 2001:db8::/32 2002::/16 3fff::/20].none? { |network| IPAddr.new(network).include?(address) }
rescue IPAddr::InvalidAddressError
  normalized.include?('.') && normalized.split('.').last.to_s.match?(/[a-z]/) && normalized.split('.', -1).all? { |label| label.match?(/\A[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\z/) }
end

def canonical_payment_https_url(value, field)
  uri = canonical_https_url(value, field)
  authority = value.split('/', 4)[2].to_s
  explicit_port = authority[/:(\d+)\z/, 1]
  path = URI.decode_www_form_component(uri.path)
  valid = value.start_with?('https://') && !value.match?(/[\s\\]/) && !value.include?('?') && !value.include?('#') &&
    (!explicit_port || (explicit_port != '443' && explicit_port == uri.port.to_s)) && !path.split('/').any? { |segment| %w[. ..].include?(segment) }
  raise ProductionManifestBindingError, "#{field} must be a canonical public HTTPS URL" unless valid
  uri
rescue ArgumentError
  raise ProductionManifestBindingError, "#{field} must be a canonical public HTTPS URL"
end

def ingress_path(rule, path, path_type, service_name)
  Array(rule&.dig('http', 'paths')).any? do |entry|
    entry.is_a?(Hash) && entry['path'] == path && entry['pathType'] == path_type &&
      entry.dig('backend', 'service', 'name') == service_name && entry.dig('backend', 'service', 'port', 'name') == 'http'
  end
end

begin
  config_path, manifest_path = ARGV
  raise ProductionManifestBindingError, 'production config path is required' unless config_path && File.file?(config_path)
  raise ProductionManifestBindingError, 'rendered manifest path is required' unless manifest_path && File.file?(manifest_path)

  config_documents = load_yaml_documents(config_path)
  raise ProductionManifestBindingError, 'production config must contain exactly one YAML document' unless config_documents.length == 1 && config_documents.first.is_a?(Hash)
  config = config_documents.first
  resources = flatten_resources(load_yaml_documents(manifest_path))
  runtimes = resources.select { |resource| resource.is_a?(Hash) && resource['kind'] == 'ConfigMap' && resource.dig('metadata', 'name') == 'merchant-runtime' }
  raise ProductionManifestBindingError, 'rendered manifest must contain exactly one ConfigMap/merchant-runtime' unless runtimes.length == 1
  runtime = runtimes.first['data']
  raise ProductionManifestBindingError, 'ConfigMap/merchant-runtime.data must be a mapping' unless runtime.is_a?(Hash)

  {
    'merchant_bearer_hostname' => 'MERCHANT_BEARER_HOSTNAME',
    'mcp_authorization_mode' => 'MCP_AUTHZ_MODE',
    'durable_platform_assignments_required' => 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED',
    'require_approved_asset_for_generation' => 'REQUIRE_APPROVED_ASSET_FOR_GENERATION',
    'model_relay_base_url' => 'MODEL_RELAY_BASE_URL',
    'text_model' => 'AI_MODEL',
    'image_model' => 'IMAGE_MODEL',
    'image_edit_model' => 'IMAGE_EDIT_MODEL',
    'ocr_model' => 'OCR_MODEL',
    'video_model' => 'VIDEO_MODEL',
    'embedding_model' => 'EMBEDDING_MODEL',
    'embedding_dimensions' => 'EMBEDDING_DIMENSIONS',
    'embedding_max_request_cny' => 'MODEL_EMBEDDING_MAX_REQUEST_CNY',
    'knowledge_vector_index_enabled' => 'KNOWLEDGE_VECTOR_INDEX_ENABLED',
    'approved_requests_per_minute' => 'MODEL_RPM_LIMIT',
    'approved_tokens_per_minute' => 'MODEL_TPM_LIMIT',
    'maximum_task_cost_cny' => 'MODEL_MAX_TASK_COST_CNY',
    'object_storage_bucket' => 'ASSET_STORAGE_BUCKET',
    'object_storage_region' => 'ASSET_STORAGE_REGION',
    'object_storage_endpoint' => 'ASSET_STORAGE_ENDPOINT',
    'object_storage_versioning' => 'OBJECT_STORAGE_VERSIONING',
    'asset_display_base_url' => 'PUBLIC_ASSET_BASE_URL',
    'image_artifact_allowed_hosts' => 'IMAGE_ARTIFACT_ALLOWED_HOSTS',
    'video_artifact_allowed_hosts' => 'VIDEO_ARTIFACT_ALLOWED_HOSTS',
    'asset_quarantine_retention_days' => 'ASSET_QUARANTINE_RETENTION_DAYS',
    'asset_clean_retention_days' => 'ASSET_CLEAN_RETENTION_DAYS',
    'deletion_request_grace_days' => 'DELETION_REQUEST_GRACE_DAYS',
    'backup_retention_days' => 'BACKUP_RETENTION_DAYS',
    'lifecycle_policy_ref' => 'LIFECYCLE_POLICY_REF',
    'asset_scanner_mode' => 'ASSET_SCANNER_MODE',
    'allow_local_asset_scan_fixture' => 'ALLOW_LOCAL_ASSET_SCAN_FIXTURE',
    'asset_scan_policy_version' => 'ASSET_SCAN_POLICY_VERSION',
    'clamav_signature_max_age_minutes' => 'CLAMAV_SIGNATURE_MAX_AGE_MINUTES',
    'clamav_max_file_bytes' => 'CLAMAV_MAX_FILE_BYTES',
    'payment_mode' => 'PAYMENT_MODE',
    'payment_provider_adapters' => 'PAYMENT_PROVIDER_ADAPTERS',
    'payment_checkout_base_url' => 'PAYMENT_CHECKOUT_BASE_URL',
    'payment_provider_checkout_api_url' => 'PAYMENT_PROVIDER_CHECKOUT_API_URL',
    'payment_provider_query_api_url' => 'PAYMENT_PROVIDER_QUERY_API_URL',
    'payment_provider_refund_query_api_url' => 'PAYMENT_PROVIDER_REFUND_QUERY_API_URL',
    'payment_provider_refund_api_url' => 'PAYMENT_PROVIDER_REFUND_API_URL',
    'payment_provider_merchant_id' => 'PAYMENT_PROVIDER_MERCHANT_ID',
    'payment_callback_base_url' => 'PAYMENT_CALLBACK_BASE_URL',
    'payment_reconciliation_enabled' => 'PAYMENT_RECONCILIATION_ENABLED',
    'payment_refund_enabled' => 'PAYMENT_REFUND_ENABLED',
    'commercial_payment_provider' => 'COMMERCIAL_PAYMENT_PROVIDER',
    'platform_rule_sync_manifest_url' => 'PLATFORM_RULE_SYNC_MANIFEST_URL',
    'platform_rule_sync_interval_hours' => 'PLATFORM_RULE_SYNC_INTERVAL_HOURS',
  }.each { |config_key, runtime_key| require_binding(config, runtime, config_key, runtime_key) }

  relay_url = URI.parse(required_config_leaf(config, 'model_relay_base_url'))
  unless relay_url.is_a?(URI::HTTPS) && relay_url.host && relay_url.userinfo.nil? && relay_url.fragment.nil? && relay_url.query.nil?
    raise ProductionManifestBindingError, 'model_relay_base_url must be a canonical HTTPS URL without userinfo, query, or fragment'
  end
  relay_hosts = runtime['MODEL_RELAY_ALLOWED_HOSTS'].to_s.split(',').map(&:strip).reject(&:empty?)
  raise ProductionManifestBindingError, 'MODEL_RELAY_ALLOWED_HOSTS must exactly match the configured relay host' unless relay_hosts == [relay_url.host.downcase]

  merchant_host = required_config_leaf(config, 'merchant_bearer_hostname')
  raise ProductionManifestBindingError, 'merchant_bearer_hostname must be a canonical hostname' unless merchant_host.match?(/\A[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z/) && !merchant_host.include?('..')
  app_base_url = required_config_path(config, 'app_base_url', %w[public_endpoints app_base_url])
  app_uri = canonical_https_url(app_base_url, 'app_base_url', origin: true)
  raise ProductionManifestBindingError, 'app_base_url host must match merchant_bearer_hostname' unless app_uri.host == merchant_host
  mcp_base_url = required_config_path(config, 'mcp_base_url', %w[codex mcp base_url])
  canonical_https_url(mcp_base_url, 'mcp_base_url', origin: true)
  raise ProductionManifestBindingError, 'mcp_base_url must exactly match app_base_url because the plugin appends /mcp' unless mcp_base_url.sub(%r{/$}, '') == app_base_url.sub(%r{/$}, '')
  ops_base_url = required_config_path(config, 'ops_base_url', %w[public_endpoints ops_base_url])
  ops_uri = canonical_https_url(ops_base_url, 'ops_base_url', origin: true)
  raise ProductionManifestBindingError, 'ops_base_url must use a host distinct from merchant_bearer_hostname' if ops_uri.host == merchant_host
  oauth_callback_base_url = required_config_path(config, 'oauth_callback_base_url', %w[public_endpoints oauth_callback_base_url])
  canonical_https_url(oauth_callback_base_url, 'oauth_callback_base_url')
  expected_oauth_base = "https://#{merchant_host}/v1/oauth/callback"
  raise ProductionManifestBindingError, 'oauth_callback_base_url must match the merchant callback route' unless oauth_callback_base_url == expected_oauth_base
  expected_oauth_redirect = "#{oauth_callback_base_url}/{platform}"
  raise ProductionManifestBindingError, 'PUBLIC_OAUTH_REDIRECT_URI does not match merchant_bearer_hostname' unless runtime['PUBLIC_OAUTH_REDIRECT_URI'] == expected_oauth_redirect

  payment_callback_base_url = required_config_leaf(config, 'payment_callback_base_url')
  canonical_https_url(payment_callback_base_url, 'payment_callback_base_url')
  raise ProductionManifestBindingError, 'payment_callback_base_url must match the merchant /v1 route' unless payment_callback_base_url == "https://#{merchant_host}/v1"
  %w[payment_checkout_base_url payment_provider_checkout_api_url payment_provider_query_api_url payment_provider_refund_query_api_url payment_provider_refund_api_url].each do |field|
    uri = canonical_payment_https_url(required_config_leaf(config, field), field)
    raise ProductionManifestBindingError, "#{field} must not target a local, private, or special-use literal host" unless payment_public_hostname?(uri.host)
    raise ProductionManifestBindingError, "#{field} must not target a reserved placeholder host" if placeholder_hostname?(uri.host)
  end
  merchant_id = required_config_leaf(config, 'payment_provider_merchant_id').strip
  if merchant_id.match?(/(?:example|placeholder|replace[-_]?me|change[-_]?me|dummy|demo|test)/i)
    raise ProductionManifestBindingError, 'payment_provider_merchant_id must not be a placeholder value'
  end
  rule_manifest_uri = canonical_https_url(required_config_leaf(config, 'platform_rule_sync_manifest_url'), 'platform_rule_sync_manifest_url')
  raise ProductionManifestBindingError, 'platform_rule_sync_manifest_url must not target a local or private literal host' unless public_hostname?(rule_manifest_uri.host)

  ingresses = resources.select { |resource| resource.is_a?(Hash) && resource['kind'] == 'Ingress' && resource.dig('metadata', 'name') == 'merchant' }
  raise ProductionManifestBindingError, 'rendered manifest must contain exactly one Ingress/merchant' unless ingresses.length == 1
  ingress = ingresses.first
  merchant_rule = Array(ingress.dig('spec', 'rules')).find { |rule| rule.is_a?(Hash) && rule['host'] == merchant_host }
  raise ProductionManifestBindingError, 'Ingress/merchant is missing the configured merchant host rule' unless merchant_rule
  raise ProductionManifestBindingError, 'configured merchant host must expose Prefix /v1 to merchant-api:http' unless ingress_path(merchant_rule, '/v1', 'Prefix', 'merchant-api')
  raise ProductionManifestBindingError, 'configured merchant host root must route to merchant-ui:http' unless ingress_path(merchant_rule, '/', 'Prefix', 'merchant-ui')
  ops_rule = Array(ingress.dig('spec', 'rules')).find { |rule| rule.is_a?(Hash) && rule['host'] == ops_uri.host }
  raise ProductionManifestBindingError, 'Ingress/merchant is missing the configured ops host rule' unless ops_rule
  raise ProductionManifestBindingError, 'configured ops host root must route to merchant-ops-ui:http' unless ingress_path(ops_rule, '/', 'Prefix', 'merchant-ops-ui')
  raise ProductionManifestBindingError, 'configured ops host must not expose /mcp' if Array(ops_rule.dig('http', 'paths')).any? { |path| path.is_a?(Hash) && path['path'] == '/mcp' }
  raise ProductionManifestBindingError, 'Ingress/merchant public routes must keep a 1m request-body limit' unless ingress.dig('metadata', 'annotations', 'nginx.ingress.kubernetes.io/proxy-body-size') == '1m'
  tls_hosts = Array(ingress.dig('spec', 'tls')).flat_map { |entry| entry.is_a?(Hash) ? Array(entry['hosts']) : [] }
  raise ProductionManifestBindingError, 'Ingress TLS does not cover merchant_bearer_hostname' unless tls_hosts.include?(merchant_host)
  raise ProductionManifestBindingError, 'Ingress TLS does not cover ops_base_url' unless tls_hosts.include?(ops_uri.host)

  upload_ingresses = resources.select { |resource| resource.is_a?(Hash) && resource['kind'] == 'Ingress' && resource.dig('metadata', 'name') == 'merchant-browser-api-upload' }
  raise ProductionManifestBindingError, 'rendered manifest must contain exactly one Ingress/merchant-browser-api-upload' unless upload_ingresses.length == 1
  upload_ingress = upload_ingresses.first
  raise ProductionManifestBindingError, 'browser API upload ingress must set a 70m request-body limit' unless upload_ingress.dig('metadata', 'annotations', 'nginx.ingress.kubernetes.io/proxy-body-size') == '70m'
  upload_merchant_rule = Array(upload_ingress.dig('spec', 'rules')).find { |rule| rule.is_a?(Hash) && rule['host'] == merchant_host }
  upload_ops_rule = Array(upload_ingress.dig('spec', 'rules')).find { |rule| rule.is_a?(Hash) && rule['host'] == ops_uri.host }
  raise ProductionManifestBindingError, 'configured merchant host must expose Exact /mcp to merchant-api:http in the 70m upload ingress' unless ingress_path(upload_merchant_rule, '/mcp', 'Exact', 'merchant-api')
  raise ProductionManifestBindingError, 'merchant browser Exact /api/mcp upload route must target merchant-ui:http' unless ingress_path(upload_merchant_rule, '/api/mcp', 'Exact', 'merchant-ui')
  raise ProductionManifestBindingError, 'ops browser Exact /api/mcp upload route must target merchant-ops-ui:http' unless ingress_path(upload_ops_rule, '/api/mcp', 'Exact', 'merchant-ops-ui')
  [[upload_merchant_rule, 'merchant-ui'], [upload_ops_rule, 'merchant-ops-ui']].each do |rule, ui_service|
    raise ProductionManifestBindingError, 'Exact /v1/assets/upload must target merchant-api:http in the upload ingress' unless ingress_path(rule, '/v1/assets/upload', 'Exact', 'merchant-api')
    raise ProductionManifestBindingError, "Exact /api/v1/assets/upload must target #{ui_service}:http in the upload ingress" unless ingress_path(rule, '/api/v1/assets/upload', 'Exact', ui_service)
  end
  unless Array(upload_ingress.dig('spec', 'rules')).all? { |rule| rule.is_a?(Hash) && Array(rule.dig('http', 'paths')).all? { |path| path.is_a?(Hash) && path['pathType'] == 'Exact' && (%w[/api/mcp /v1/assets/upload /api/v1/assets/upload].include?(path['path']) || (rule['host'] == merchant_host && path['path'] == '/mcp')) } }
    raise ProductionManifestBindingError, 'upload ingress must not widen the body limit beyond exact MCP and asset-upload routes'
  end

  puts 'production config/rendered manifest binding gate passed'
rescue ProductionManifestBindingError => error
  warn error.message
  exit 1
end
