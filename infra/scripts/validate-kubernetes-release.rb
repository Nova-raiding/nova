# frozen_string_literal: true

require 'psych'
require 'json'
require 'digest'

class ReleaseManifestError < StandardError; end

WORKLOAD_POD_SPEC_PATHS = {
  'Pod' => ['spec'],
  'PodTemplate' => ['template', 'spec'],
  'Deployment' => ['spec', 'template', 'spec'],
  'ReplicaSet' => ['spec', 'template', 'spec'],
  'StatefulSet' => ['spec', 'template', 'spec'],
  'DaemonSet' => ['spec', 'template', 'spec'],
  'ReplicationController' => ['spec', 'template', 'spec'],
  'Job' => ['spec', 'template', 'spec'],
  'CronJob' => ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
}.freeze

NON_WORKLOAD_KINDS = %w[
  Namespace ConfigMap Service Ingress NetworkPolicy
  PodDisruptionBudget HorizontalPodAutoscaler VerticalPodAutoscaler
  ServiceAccount Role RoleBinding ClusterRole ClusterRoleBinding
  PersistentVolume PersistentVolumeClaim StorageClass
].freeze

CONTAINER_FIELDS = %w[containers initContainers ephemeralContainers].freeze
IMAGE_PATTERN = /\A[^\s@]+@sha256:[0-9a-f]{64}\z/i.freeze
DIGEST_PATTERN = /\Asha256:[0-9a-f]{64}\z/i.freeze
REQUIRED_IMAGE_NAMES = %w[clamav merchant-api merchant-ops-ui merchant-ui merchant-worker].freeze
CONFIG_DIGEST_ANNOTATION = 'merchant.example.com/config-sha256'
SECRET_LIKE_CONFIG_KEY = /(?:\A|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|DATABASE_URL|REDIS_URL|CONNECTION_STRING|CREDENTIALS?)\z/i.freeze
WORKLOAD_SECRET_KEYS = {
  'merchant-api' => {
    'merchant-runtime-secrets' => %w[
      DATABASE_URL OPS_DATABASE_URL REDIS_URL API_AUTH_TOKENS
      OIDC_PROXY_SIGNING_SECRET SESSION_ID_HASH_SECRET
      WORKER_API_CREDENTIALS
      ASSET_STORAGE_KMS_KEY_ID ASSET_DISPLAY_URL_SIGNING_SECRET ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON VAULT_TOKEN RULE_APPROVAL_TOKENS
      PLATFORM_RULE_SYNC_SIGNING_SECRET MODEL_RELAY_API_KEY
      PAYMENT_PROVIDER_API_KEY PAYMENT_CALLBACK_SECRET
      OPS_CUSTOMER_ACCESS_SIGNING_SECRET
    ],
    'merchant-scanner-secrets' => %w[ASSET_SCANNER_API_TOKEN ASSET_SCANNER_WORKSPACE_SIGNING_SECRET ASSET_SCAN_TRUSTED_PUBLIC_KEYS],
  },
  'merchant-worker-sync' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL WORKER_SYNC_API_TOKEN WORKER_SYNC_API_SIGNING_SECRET VAULT_TOKEN],
  },
  'merchant-worker-generation' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL WORKER_GENERATION_API_TOKEN WORKER_GENERATION_API_SIGNING_SECRET MODEL_RELAY_API_KEY],
  },
  'merchant-worker-publish' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL WORKER_PUBLISH_API_TOKEN WORKER_PUBLISH_API_SIGNING_SECRET VAULT_TOKEN],
  },
  'merchant-worker-reconcile' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL WORKER_RECONCILE_API_TOKEN WORKER_RECONCILE_API_SIGNING_SECRET VAULT_TOKEN],
  },
  'merchant-worker-automation' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL WORKER_AUTOMATION_API_TOKEN WORKER_AUTOMATION_API_SIGNING_SECRET],
  },
  'merchant-worker-scan' => {
    'merchant-runtime-secrets' => %w[DATABASE_URL REDIS_URL],
    'merchant-scanner-secrets' => %w[ASSET_SCANNER_API_TOKEN ASSET_SCANNER_WORKSPACE_SIGNING_SECRET ASSET_SCAN_RECEIPT_KEY_ID ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM],
  },
  'merchant-ui' => {
    'merchant-runtime-secrets' => %w[MERCHANT_UI_API_TOKEN],
  },
  'merchant-schema-migration' => {
    'merchant-migration-secrets' => %w[DATABASE_URL],
  },
}.freeze
KNOWN_SECRET_KEYS = WORKLOAD_SECRET_KEYS.values.flat_map { |secrets| secrets.values }.flatten.uniq.freeze
SCANNER_CONFIG = {
  'ALLOW_LOCAL_ASSET_SCAN_FIXTURE' => 'false',
  'ASSET_SCANNER_MODE' => 'clamav_worker',
  'CLAMAV_HOST' => '127.0.0.1',
  'CLAMAV_PORT' => '3310',
  'CLAMAV_MAX_FILE_BYTES' => '52428800',
}.freeze
AUTHORIZATION_CONFIG = {
  'MCP_AUTHZ_MODE' => 'enforce',
  'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED' => 'true',
}.freeze
SCANNER_API_SECRET_ENV = {
  'ASSET_SCANNER_API_TOKEN' => ['merchant-scanner-secrets', 'ASSET_SCANNER_API_TOKEN'],
  'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET' => ['merchant-scanner-secrets', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'],
  'ASSET_SCAN_TRUSTED_PUBLIC_KEYS' => ['merchant-scanner-secrets', 'ASSET_SCAN_TRUSTED_PUBLIC_KEYS'],
}.freeze
CRITICAL_API_SECRET_ENV = {
  'MODEL_RELAY_API_KEY' => ['merchant-runtime-secrets', 'MODEL_RELAY_API_KEY'],
  'PLATFORM_RULE_SYNC_SIGNING_SECRET' => ['merchant-runtime-secrets', 'PLATFORM_RULE_SYNC_SIGNING_SECRET'],
  'PAYMENT_PROVIDER_API_KEY' => ['merchant-runtime-secrets', 'PAYMENT_PROVIDER_API_KEY'],
  'PAYMENT_CALLBACK_SECRET' => ['merchant-runtime-secrets', 'PAYMENT_CALLBACK_SECRET'],
}.freeze
SCANNER_WORKER_SECRET_ENV = {
  'WORKER_API_TOKEN' => ['merchant-scanner-secrets', 'ASSET_SCANNER_API_TOKEN'],
  'WORKER_API_SIGNING_SECRET' => ['merchant-scanner-secrets', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'],
  'ASSET_SCANNER_API_TOKEN' => ['merchant-scanner-secrets', 'ASSET_SCANNER_API_TOKEN'],
  'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET' => ['merchant-scanner-secrets', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'],
  'ASSET_SCAN_RECEIPT_KEY_ID' => ['merchant-scanner-secrets', 'ASSET_SCAN_RECEIPT_KEY_ID'],
}.freeze
WORKER_ROLE_CREDENTIAL_CONTRACT = {
  'merchant-worker-sync' => ['sync', 'WORKER_SYNC_API_TOKEN', 'WORKER_SYNC_API_SIGNING_SECRET'],
  'merchant-worker-generation' => ['generation', 'WORKER_GENERATION_API_TOKEN', 'WORKER_GENERATION_API_SIGNING_SECRET'],
  'merchant-worker-publish' => ['publish', 'WORKER_PUBLISH_API_TOKEN', 'WORKER_PUBLISH_API_SIGNING_SECRET'],
  'merchant-worker-reconcile' => ['reconcile', 'WORKER_RECONCILE_API_TOKEN', 'WORKER_RECONCILE_API_SIGNING_SECRET'],
  'merchant-worker-automation' => ['automation', 'WORKER_AUTOMATION_API_TOKEN', 'WORKER_AUTOMATION_API_SIGNING_SECRET'],
}.freeze
def convert_yaml_node(node, path = '$')
  raise ReleaseManifestError, "anchors and aliases are not allowed at #{path}" if node.respond_to?(:anchor) && node.anchor

  case node
  when Psych::Nodes::Scalar
    node.value
  when Psych::Nodes::Sequence
    node.children.each_with_index.map { |child, index| convert_yaml_node(child, "#{path}[#{index}]") }
  when Psych::Nodes::Mapping
    result = {}
    node.children.each_slice(2) do |key_node, value_node|
      key = convert_yaml_node(key_node, "#{path}.<key>")
      raise ReleaseManifestError, "mapping key must be a scalar at #{path}" unless key.is_a?(String)
      raise ReleaseManifestError, "duplicate mapping key #{key.inspect} at #{path}" if result.key?(key)

      result[key] = convert_yaml_node(value_node, "#{path}.#{key}")
    end
    result
  when Psych::Nodes::Alias
    raise ReleaseManifestError, "anchors and aliases are not allowed at #{path}"
  else
    raise ReleaseManifestError, "unsupported YAML node #{node.class} at #{path}"
  end
end

def nested_hash(value, keys, context)
  keys.reduce(value) do |current, key|
    raise ReleaseManifestError, "#{context} is missing #{keys.join('.')}" unless current.is_a?(Hash) && current.key?(key)

    current[key]
  end
end

def image_name(image)
  image.split('@', 2).first.split('/').last
end

def validate_image(image, expected_digests, observed_images, context)
  raise ReleaseManifestError, "#{context}.image is required" unless image.is_a?(String) && !image.empty?
  raise ReleaseManifestError, "unresolved or mutable image reference at #{context}: #{image}" if image.include?('REPLACE_ME') || image.match?(/:latest(?:@|\z)/)
  raise ReleaseManifestError, "image must use an immutable sha256 digest at #{context}: #{image}" unless image.match?(IMAGE_PATTERN)

  image_digest = image.split('@', 2).last
  logical_name = image_name(image)
  expected_digest = expected_digests[logical_name] || expected_digests['*']
  raise ReleaseManifestError, "image #{logical_name} is not present in IMAGE_DIGESTS_JSON at #{context}" unless expected_digest
  raise ReleaseManifestError, "image digest does not match the canonical image set at #{context}: #{image}" unless image_digest.downcase == expected_digest
  observed_images[logical_name] = image_digest.downcase
end

def optional_reference?(reference)
  reference.is_a?(Hash) && reference['optional'].to_s.casecmp('true').zero?
end

def validate_config_map_reference(reference, config_maps, config_map_refs, context)
  raise ReleaseManifestError, "#{context} must be a mapping" unless reference.is_a?(Hash)
  name = reference['name']
  raise ReleaseManifestError, "#{context}.name is required" unless name.is_a?(String) && !name.empty?
  raise ReleaseManifestError, "optional ConfigMap references are forbidden at #{context}" if optional_reference?(reference)
  raise ReleaseManifestError, "ConfigMap #{name} referenced at #{context} is not bound into the rendered manifest" unless config_maps.key?(name)
  config_map_refs << name
end

def validate_secret_key_reference(reference, workload_name, context)
  raise ReleaseManifestError, "#{context} must be a mapping" unless reference.is_a?(Hash)
  name = reference['name']
  key = reference['key']
  raise ReleaseManifestError, "#{context}.name and .key are required" unless name.is_a?(String) && !name.empty? && key.is_a?(String) && !key.empty?
  raise ReleaseManifestError, "optional Secret key references are forbidden at #{context}" if optional_reference?(reference)
  allowed = WORKLOAD_SECRET_KEYS.dig(workload_name, name) || []
  raise ReleaseManifestError, "Secret key reference is not allowed for #{workload_name}: #{name}/#{key}" unless allowed.include?(key)
end

def validate_container_environment(container, workload_name, config_maps, config_map_refs, context)
  if container.key?('envFrom')
    sources = container['envFrom']
    raise ReleaseManifestError, "#{context}.envFrom must be an array" unless sources.is_a?(Array)
    sources.each_with_index do |source, index|
      source_context = "#{context}.envFrom[#{index}]"
      raise ReleaseManifestError, "#{source_context} must be a mapping" unless source.is_a?(Hash)
      raise ReleaseManifestError, "whole-Secret envFrom injection is forbidden at #{source_context}" if source.key?('secretRef')
      raise ReleaseManifestError, "#{source_context} must contain only configMapRef" unless source.keys == ['configMapRef']
      validate_config_map_reference(source['configMapRef'], config_maps, config_map_refs, "#{source_context}.configMapRef")
    end
  end

  return unless container.key?('env')
  entries = container['env']
  raise ReleaseManifestError, "#{context}.env must be an array" unless entries.is_a?(Array)
  entries.each_with_index do |entry, index|
    raise ReleaseManifestError, "#{context}.env[#{index}] must be a mapping" unless entry.is_a?(Hash)
    if AUTHORIZATION_CONFIG.key?(entry['name'])
      raise ReleaseManifestError, "#{context}.env[#{index}] must not override #{entry['name']}; production authorization settings must come only from ConfigMap/merchant-runtime"
    end
    next unless entry.key?('valueFrom')
    raise ReleaseManifestError, "#{context}.env[#{index}].valueFrom must be a mapping" unless entry['valueFrom'].is_a?(Hash)
    value_from = entry['valueFrom']
    entry_context = "#{context}.env[#{index}].valueFrom"
    validate_secret_key_reference(value_from['secretKeyRef'], workload_name, "#{entry_context}.secretKeyRef") if value_from.key?('secretKeyRef')
    validate_config_map_reference(value_from['configMapKeyRef'], config_maps, config_map_refs, "#{entry_context}.configMapKeyRef") if value_from.key?('configMapKeyRef')
  end
end

def validate_authorization_contract(documents, config_maps)
  runtime = config_maps['merchant-runtime']
  raise ReleaseManifestError, 'production authorization requires the merchant-runtime ConfigMap in the rendered manifest' unless runtime
  data = runtime['data']
  raise ReleaseManifestError, 'merchant-runtime.data must be a mapping' unless data.is_a?(Hash)
  AUTHORIZATION_CONFIG.each do |key, expected|
    raise ReleaseManifestError, "merchant-runtime must set #{key}=#{expected}" unless data[key] == expected
  end
  runtime_binary = runtime['binaryData'] || {}
  raise ReleaseManifestError, 'merchant-runtime.binaryData must be a mapping' unless runtime_binary.is_a?(Hash)
  duplicated_binary_key = AUTHORIZATION_CONFIG.keys.find { |key| runtime_binary.key?(key) }
  raise ReleaseManifestError, "merchant-runtime must not define #{duplicated_binary_key} in binaryData" if duplicated_binary_key

  config_maps.each do |name, config_map|
    next if name == 'merchant-runtime'
    %w[data binaryData].each do |section|
      values = config_map[section] || {}
      next unless values.is_a?(Hash)
      duplicate = AUTHORIZATION_CONFIG.keys.find { |key| values.key?(key) }
      raise ReleaseManifestError, "ConfigMap/#{name} must not define production authorization setting #{duplicate}" if duplicate
    end
  end

  resources = flattened_resources(documents)
  api = named_resource(resources, 'Deployment', 'merchant-api')
  raise ReleaseManifestError, 'production authorization requires Deployment/merchant-api' unless api
  api_container = named_container(api, 'api')
  sources = api_container['envFrom']
  bound = sources.is_a?(Array) && sources.any? do |source|
    reference = source.is_a?(Hash) ? source['configMapRef'] : nil
    reference.is_a?(Hash) && reference['name'] == 'merchant-runtime' && !optional_reference?(reference)
  end
  raise ReleaseManifestError, 'merchant-api/api must import production authorization settings from ConfigMap/merchant-runtime' unless bound
end

def validate_secret_volume_reference(reference, workload_name, context)
  raise ReleaseManifestError, "#{context} must be a mapping" unless reference.is_a?(Hash)
  name = reference['secretName'] || reference['name']
  raise ReleaseManifestError, "#{context} must name a Secret" unless name.is_a?(String) && !name.empty?
  raise ReleaseManifestError, "optional Secret volume references are forbidden at #{context}" if optional_reference?(reference)
  items = reference['items']
  unless items.is_a?(Array) && !items.empty?
    raise ReleaseManifestError, "whole-Secret volume injection is forbidden at #{context}"
  end
  allowed = WORKLOAD_SECRET_KEYS.dig(workload_name, name) || []
  items.each_with_index do |item, index|
    item_context = "#{context}.items[#{index}]"
    raise ReleaseManifestError, "#{item_context} must be a mapping" unless item.is_a?(Hash)
    key = item['key']
    path = item['path']
    raise ReleaseManifestError, "#{item_context}.key and .path are required" unless key.is_a?(String) && !key.empty? && path.is_a?(String) && !path.empty?
    raise ReleaseManifestError, "Secret key reference is not allowed for #{workload_name}: #{name}/#{key}" unless allowed.include?(key)
    raise ReleaseManifestError, "#{item_context}.path must be a relative filename" if path.start_with?('/') || path.split('/').include?('..')
  end
end

def validate_pod_spec(pod_spec, expected_digests, observed_images, workload_name, config_maps, context)
  raise ReleaseManifestError, "#{context} must be a mapping" unless pod_spec.is_a?(Hash)

  containers = pod_spec['containers']
  raise ReleaseManifestError, "#{context}.containers must be a non-empty array" unless containers.is_a?(Array) && !containers.empty?

  image_count = 0
  config_map_refs = []
  CONTAINER_FIELDS.each do |field|
    next unless pod_spec.key?(field)

    entries = pod_spec[field]
    raise ReleaseManifestError, "#{context}.#{field} must be an array" unless entries.is_a?(Array)

    entries.each_with_index do |container, index|
      raise ReleaseManifestError, "#{context}.#{field}[#{index}] must be a mapping" unless container.is_a?(Hash)

      name = container['name']
      label = name.is_a?(String) && !name.empty? ? name : index.to_s
      validate_image(container['image'], expected_digests, observed_images, "#{context}.#{field}[#{label}]")
      validate_container_environment(container, workload_name, config_maps, config_map_refs, "#{context}.#{field}[#{label}]")
      image_count += 1
    end
  end
  volumes = pod_spec['volumes']
  if volumes
    raise ReleaseManifestError, "#{context}.volumes must be an array" unless volumes.is_a?(Array)
    volumes.each_with_index do |volume, index|
      next unless volume.is_a?(Hash)
      volume_context = "#{context}.volumes[#{index}]"
      validate_secret_volume_reference(volume['secret'], workload_name, "#{volume_context}.secret") if volume.key?('secret')
      projected_sources = volume.dig('projected', 'sources')
      if projected_sources
        raise ReleaseManifestError, "#{volume_context}.projected.sources must be an array" unless projected_sources.is_a?(Array)
        projected_sources.each_with_index do |source, source_index|
          next unless source.is_a?(Hash) && source.key?('secret')
          validate_secret_volume_reference(source['secret'], workload_name, "#{volume_context}.projected.sources[#{source_index}].secret")
        end
      end
    end
  end
  [image_count, config_map_refs.uniq.sort]
end

def canonical_config_map_digest(config_maps, names)
  canonical = names.sort.map do |name|
    config_map = config_maps.fetch(name)
    sections = %w[data binaryData].flat_map do |section|
      values = config_map[section] || {}
      values.sort.map { |key, value| "#{section}.#{key}=#{value}\n" }
    end
    "#{name}\n#{sections.join}"
  end.join
  "sha256:#{Digest::SHA256.hexdigest(canonical)}"
end

def pod_template_metadata(resource, kind)
  case kind
  when 'Pod' then resource['metadata']
  when 'CronJob' then resource.dig('spec', 'jobTemplate', 'spec', 'template', 'metadata')
  when 'PodTemplate' then resource.dig('template', 'metadata')
  else resource.dig('spec', 'template', 'metadata')
  end
end

def validate_resource(resource, expected_digests, observed_images, config_maps, context, rollback_mode = false)
  raise ReleaseManifestError, "#{context} must be a Kubernetes object" unless resource.is_a?(Hash)

  api_version = resource['apiVersion']
  kind = resource['kind']
  raise ReleaseManifestError, "#{context}.apiVersion is required" unless api_version.is_a?(String) && !api_version.empty?
  raise ReleaseManifestError, "#{context}.kind is required" unless kind.is_a?(String) && !kind.empty?

  if rollback_mode && kind != 'Deployment'
    raise ReleaseManifestError, "resource kind is forbidden in a runtime rollback manifest: #{kind}"
  end

  if kind == 'List'
    items = resource['items']
    raise ReleaseManifestError, "#{context}.items must be a non-empty array" unless items.is_a?(Array) && !items.empty?
    return items.each_with_index.sum { |item, index| validate_resource(item, expected_digests, observed_images, config_maps, "#{context}.items[#{index}]", rollback_mode) }
  end

  raise ReleaseManifestError, 'Secret resources are forbidden in rendered release manifests; provision them through the managed secret store' if kind == 'Secret'
  if kind == 'ConfigMap'
    %w[data binaryData].each do |section|
      values = resource[section] || {}
      raise ReleaseManifestError, "#{context}.#{section} must be a mapping" unless values.is_a?(Hash)
      values.each_key do |key|
        next if key.end_with?('_SECRET_REF')
        raise ReleaseManifestError, "secret-like ConfigMap key is forbidden: #{key}" if KNOWN_SECRET_KEYS.include?(key) || key.match?(SECRET_LIKE_CONFIG_KEY)
      end
    end
  end

  pod_spec_path = WORKLOAD_POD_SPEC_PATHS[kind]
  return 0 if NON_WORKLOAD_KINDS.include?(kind)
  raise ReleaseManifestError, "unsupported Kubernetes resource kind: #{kind}" unless pod_spec_path

  name = resource.dig('metadata', 'name')
  workload = name.is_a?(String) && !name.empty? ? "#{kind}/#{name}" : "#{context}(#{kind})"
  workload_name = name.is_a?(String) ? name : ''
  pod_spec = nested_hash(resource, pod_spec_path, workload)
  image_count, config_map_refs = validate_pod_spec(pod_spec, expected_digests, observed_images, workload_name, config_maps, "#{workload}.#{pod_spec_path.join('.')}")
  unless config_map_refs.empty?
    annotations = pod_template_metadata(resource, kind)
    actual_digest = annotations.is_a?(Hash) ? annotations.dig('annotations', CONFIG_DIGEST_ANNOTATION) : nil
    expected_digest = canonical_config_map_digest(config_maps, config_map_refs)
    raise ReleaseManifestError, "#{workload} must bind referenced ConfigMaps with #{CONFIG_DIGEST_ANNOTATION}=#{expected_digest}" unless actual_digest == expected_digest
  end
  image_count
end


def collect_config_maps(resources)
  config_maps = {}
  visit = lambda do |resource, context|
    raise ReleaseManifestError, "#{context} must be a Kubernetes object" unless resource.is_a?(Hash)
    if resource['kind'] == 'List'
      items = resource['items']
      raise ReleaseManifestError, "#{context}.items must be a non-empty array" unless items.is_a?(Array) && !items.empty?
      items.each_with_index { |item, index| visit.call(item, "#{context}.items[#{index}]") }
    elsif resource['kind'] == 'ConfigMap'
      name = resource.dig('metadata', 'name')
      raise ReleaseManifestError, "#{context} ConfigMap metadata.name is required" unless name.is_a?(String) && !name.empty?
      raise ReleaseManifestError, "duplicate ConfigMap in rendered manifest: #{name}" if config_maps.key?(name)
      config_maps[name] = resource
    end
  end
  resources.each_with_index { |resource, index| visit.call(resource, "document[#{index}]") }
  config_maps
end

def flattened_resources(resources)
  flattened = []
  visit = lambda do |resource|
    if resource.is_a?(Hash) && resource['kind'] == 'List'
      (resource['items'] || []).each { |item| visit.call(item) }
    else
      flattened << resource
    end
  end
  resources.each { |resource| visit.call(resource) }
  flattened
end

def named_resource(resources, kind, name)
  resources.find { |resource| resource.is_a?(Hash) && resource['kind'] == kind && resource.dig('metadata', 'name') == name }
end

def named_container(deployment, name)
  containers = deployment.dig('spec', 'template', 'spec', 'containers')
  raise ReleaseManifestError, "Deployment/#{deployment.dig('metadata', 'name')} containers must be an array" unless containers.is_a?(Array)
  container = containers.find { |candidate| candidate.is_a?(Hash) && candidate['name'] == name }
  raise ReleaseManifestError, "Deployment/#{deployment.dig('metadata', 'name')} must contain container #{name}" unless container
  container
end

def environment_entry(container, name)
  entries = container['env'] || []
  raise ReleaseManifestError, "container #{container['name']} env must be an array" unless entries.is_a?(Array)
  entries.find { |entry| entry.is_a?(Hash) && entry['name'] == name }
end

def require_literal_environment(container, name, expected)
  entry = environment_entry(container, name)
  raise ReleaseManifestError, "container #{container['name']} must set #{name}=#{expected}" unless entry && entry['value'] == expected
end

def require_secret_environment(container, contract)
  contract.each do |environment_name, (secret_name, secret_key)|
    entry = environment_entry(container, environment_name)
    reference = entry&.dig('valueFrom', 'secretKeyRef')
    unless reference.is_a?(Hash) && reference['name'] == secret_name && reference['key'] == secret_key && !optional_reference?(reference)
      raise ReleaseManifestError, "container #{container['name']} must bind #{environment_name} to #{secret_name}/#{secret_key}"
    end
  end
end

def validate_worker_role_credentials(documents)
  resources = flattened_resources(documents)
  present_workers = WORKER_ROLE_CREDENTIAL_CONTRACT.keys.select { |name| named_resource(resources, 'Deployment', name) }
  return if present_workers.empty?
  unless present_workers.sort == WORKER_ROLE_CREDENTIAL_CONTRACT.keys.sort
    raise ReleaseManifestError, 'production worker credential gate requires sync, generation, publish, reconcile, and automation deployments together'
  end

  api = named_resource(resources, 'Deployment', 'merchant-api')
  raise ReleaseManifestError, 'worker credential gate requires Deployment/merchant-api' unless api
  require_secret_environment(named_container(api, 'api'), {
    'WORKER_API_CREDENTIALS' => ['merchant-runtime-secrets', 'WORKER_API_CREDENTIALS'],
  })

  observed_keys = []
  WORKER_ROLE_CREDENTIAL_CONTRACT.each do |deployment_name, (role, token_key, signing_key)|
    container = named_container(named_resource(resources, 'Deployment', deployment_name), 'worker')
    require_literal_environment(container, 'WORKER_ROLE', role)
    require_secret_environment(container, {
      'WORKER_API_TOKEN' => ['merchant-runtime-secrets', token_key],
      'WORKER_API_SIGNING_SECRET' => ['merchant-runtime-secrets', signing_key],
    })
    observed_keys.concat([token_key, signing_key])
  end
  raise ReleaseManifestError, 'worker roles must not share Secret keys' unless observed_keys.uniq.length == observed_keys.length
end

def probe_command(container, probe_name)
  command = container.dig(probe_name, 'exec', 'command')
  command.is_a?(Array) ? command.join(' ') : ''
end

def validate_asset_scanner_contract(documents, config_maps)
  resources = flattened_resources(documents)
  runtime = config_maps['merchant-runtime']
  raise ReleaseManifestError, 'asset scanner requires the merchant-runtime ConfigMap in the rendered manifest' unless runtime
  data = runtime['data']
  raise ReleaseManifestError, 'merchant-runtime.data must be a mapping' unless data.is_a?(Hash)
  SCANNER_CONFIG.each do |key, expected|
    raise ReleaseManifestError, "merchant-runtime must set #{key}=#{expected}" unless data[key] == expected
  end
  policy_version = data['ASSET_SCAN_POLICY_VERSION']
  unless policy_version.is_a?(String) && policy_version.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]{2,127}\z/) && !policy_version.downcase.include?('local')
    raise ReleaseManifestError, 'merchant-runtime ASSET_SCAN_POLICY_VERSION must be an immutable non-local version'
  end
  signature_age = Integer(data['CLAMAV_SIGNATURE_MAX_AGE_MINUTES'], exception: false)
  raise ReleaseManifestError, 'CLAMAV_SIGNATURE_MAX_AGE_MINUTES must be from 1 to 1440' unless signature_age&.between?(1, 1440)

  api = named_resource(resources, 'Deployment', 'merchant-api')
  raise ReleaseManifestError, 'production manifest must contain Deployment/merchant-api' unless api
  api_container = named_container(api, 'api')
  require_secret_environment(api_container, SCANNER_API_SECRET_ENV)
  require_secret_environment(api_container, CRITICAL_API_SECRET_ENV)
  if environment_entry(api_container, 'ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM')
    raise ReleaseManifestError, 'merchant-api must never receive ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM'
  end

  scanner = named_resource(resources, 'Deployment', 'merchant-worker-scan')
  raise ReleaseManifestError, 'production manifest must contain Deployment/merchant-worker-scan' unless scanner
  pod_spec = scanner.dig('spec', 'template', 'spec')
  raise ReleaseManifestError, 'merchant-worker-scan must target kubernetes.io/arch=amd64' unless pod_spec&.dig('nodeSelector', 'kubernetes.io/arch') == 'amd64'
  worker = named_container(scanner, 'worker')
  clamav = named_container(scanner, 'clamav')
  raise ReleaseManifestError, 'merchant-worker-scan worker must use merchant-worker image' unless image_name(worker['image'].to_s) == 'merchant-worker'
  raise ReleaseManifestError, 'merchant-worker-scan clamav container must use clamav image' unless image_name(clamav['image'].to_s) == 'clamav'
  require_literal_environment(worker, 'WORKER_ROLE', 'scan')
  require_secret_environment(worker, SCANNER_WORKER_SECRET_ENV)
  %w[startupProbe livenessProbe].each do |probe|
    raise ReleaseManifestError, "clamav #{probe} must fail closed on clamd PING" unless probe_command(clamav, probe).include?('clamdscan --ping 1')
  end
  readiness = probe_command(clamav, 'readinessProbe')
  unless readiness.include?('clamdscan --ping 1') && readiness.include?('-mmin -1440')
    raise ReleaseManifestError, 'clamav readinessProbe must require clamd PING and signatures no older than 1440 minutes'
  end
end

def parse_expected_digests(specification)
  if specification.start_with?('{')
    begin
      parsed = JSON.parse(specification)
    rescue JSON::ParserError => error
      raise ReleaseManifestError, "IMAGE_DIGESTS_JSON is invalid JSON: #{error.message}"
    end
    raise ReleaseManifestError, 'IMAGE_DIGESTS_JSON must be an object' unless parsed.is_a?(Hash)
    keys = parsed.keys.sort
    raise ReleaseManifestError, "IMAGE_DIGESTS_JSON must contain exactly #{REQUIRED_IMAGE_NAMES.join(', ')}" unless keys == REQUIRED_IMAGE_NAMES
    parsed.transform_values do |digest|
      raise ReleaseManifestError, 'every image digest must be sha256 plus exactly 64 hexadecimal characters' unless digest.is_a?(String) && digest.match?(DIGEST_PATTERN)
      digest.downcase
    end
  else
    raise ReleaseManifestError, 'legacy image digest must be sha256 plus exactly 64 hexadecimal characters' unless specification.match?(DIGEST_PATTERN)
    { '*' => specification.downcase }
  end
end

def canonical_image_set(expected_digests)
  expected_digests.sort.map { |name, digest| "#{name}=#{digest}\n" }.join
end

begin
  manifest_path, digest_specification, *modes = ARGV
  output_mode = modes.include?('--print-image-set-digest') ? '--print-image-set-digest' : nil
  rollback_mode = modes.include?('--rollback')
  raise ReleaseManifestError, 'rendered Kubernetes manifest path is required' unless manifest_path && !manifest_path.empty?
  raise ReleaseManifestError, 'IMAGE_DIGESTS_JSON or a legacy image digest is required' unless digest_specification && !digest_specification.empty?
  expected_digests = parse_expected_digests(digest_specification)

  begin
    stream = Psych.parse_stream(File.read(manifest_path, encoding: 'UTF-8'))
  rescue Psych::SyntaxError, EncodingError => error
    raise ReleaseManifestError, "invalid Kubernetes YAML: #{error.message}"
  end

  documents = []
  stream.children.each_with_index do |document, index|
    next if document.root.nil?

    documents << convert_yaml_node(document.root, "$document[#{index}]")
  end
  raise ReleaseManifestError, 'rendered Kubernetes manifest contains no resources' if documents.empty?

  observed_images = {}
  config_maps = collect_config_maps(documents)
  if !rollback_mode && !expected_digests.key?('*')
    validate_authorization_contract(documents, config_maps)
    validate_asset_scanner_contract(documents, config_maps)
  end
  image_count = documents.each_with_index.sum { |document, index| validate_resource(document, expected_digests, observed_images, config_maps, "document[#{index}]", rollback_mode) }
  raise ReleaseManifestError, 'rendered Kubernetes manifest contains no supported workload container image' if image_count.zero?
  if expected_digests.key?('*')
    raise ReleaseManifestError, 'legacy single IMAGE_DIGEST is allowed only for a one-image non-production manifest' unless observed_images.keys.length == 1
  else
    missing = REQUIRED_IMAGE_NAMES - observed_images.keys
    raise ReleaseManifestError, "rendered Kubernetes manifest does not use required images: #{missing.join(', ')}" unless missing.empty?
  end
  validate_worker_role_credentials(documents) unless rollback_mode

  canonical = canonical_image_set(expected_digests)
  image_set_digest = "sha256:#{Digest::SHA256.hexdigest(canonical)}"
  if output_mode == '--print-image-set-digest'
    puts image_set_digest
  else
    puts "Kubernetes release manifest gate passed: images=#{image_count} image_set_digest=#{image_set_digest} manifest=#{manifest_path}"
  end
rescue ReleaseManifestError => error
  warn error.message
  exit 1
end
