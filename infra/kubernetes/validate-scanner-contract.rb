# frozen_string_literal: true

require 'psych'

class ScannerContractError < StandardError; end

def convert(node, path = '$')
  raise ScannerContractError, "anchors and aliases are not allowed at #{path}" if node.respond_to?(:anchor) && node.anchor

  case node
  when Psych::Nodes::Scalar
    node.value
  when Psych::Nodes::Sequence
    node.children.each_with_index.map { |child, index| convert(child, "#{path}[#{index}]") }
  when Psych::Nodes::Mapping
    node.children.each_slice(2).each_with_object({}) do |(key_node, value_node), result|
      key = convert(key_node, "#{path}.<key>")
      raise ScannerContractError, "mapping key must be a scalar at #{path}" unless key.is_a?(String)
      raise ScannerContractError, "duplicate mapping key #{key.inspect} at #{path}" if result.key?(key)

      result[key] = convert(value_node, "#{path}.#{key}")
    end
  when Psych::Nodes::Alias
    raise ScannerContractError, "anchors and aliases are not allowed at #{path}"
  else
    raise ScannerContractError, "unsupported YAML node #{node.class} at #{path}"
  end
end

def flatten(resources)
  resources.flat_map do |resource|
    resource.is_a?(Hash) && resource['kind'] == 'List' ? flatten(resource['items'] || []) : [resource]
  end
end

def named(resources, kind, name)
  resources.find { |resource| resource.is_a?(Hash) && resource['kind'] == kind && resource.dig('metadata', 'name') == name }
end

def require_config_map_reference(container, name)
  references = container['envFrom'] || []
  return if references.any? { |entry| entry.dig('configMapRef', 'name') == name && entry.dig('configMapRef', 'optional').to_s != 'true' }

  raise ScannerContractError, "container #{container['name']} must require ConfigMap/#{name}"
end

def require_config_key_environment(container, environment_name, config_name, key)
  entry = (container['env'] || []).find { |candidate| candidate['name'] == environment_name }
  reference = entry&.dig('valueFrom', 'configMapKeyRef')
  return if reference == { 'name' => config_name, 'key' => key }

  raise ScannerContractError, "container #{container['name']} must bind #{environment_name} to ConfigMap/#{config_name}:#{key}"
end

begin
  manifest_path = ARGV.fetch(0) { raise ScannerContractError, 'rendered Kubernetes manifest path is required' }
  stream = Psych.parse_stream(File.read(manifest_path, encoding: 'UTF-8'))
  documents = stream.children.filter_map { |document| convert(document.root) unless document.root.nil? }
  resources = flatten(documents)

  runtime = named(resources, 'ConfigMap', 'merchant-runtime')
  raise ScannerContractError, 'ConfigMap/merchant-runtime is required' unless runtime
  data = runtime['data']
  raise ScannerContractError, 'ConfigMap/merchant-runtime data must be a mapping' unless data.is_a?(Hash)

  service_id = data['ASSET_SCANNER_SERVICE_ID']
  identity_pattern = /\A[A-Za-z0-9][A-Za-z0-9._-]{2,127}\z/
  raise ScannerContractError, 'ASSET_SCANNER_SERVICE_ID must be an explicit production-safe identifier' unless service_id&.match?(identity_pattern)

  approved_raw = data['ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS']
  approved = approved_raw.to_s.split(',').map(&:strip)
  unless approved.any? && approved.all? { |value| value.match?(identity_pattern) } && approved.uniq.length == approved.length
    raise ScannerContractError, 'ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS must be a non-empty unique identifier list'
  end
  raise ScannerContractError, 'ASSET_SCANNER_SERVICE_ID must be present in ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS' unless approved.include?(service_id)

  definitions_floor = Integer(data['ASSET_SCAN_MIN_DEFINITIONS_VERSION'], exception: false)
  raise ScannerContractError, 'ASSET_SCAN_MIN_DEFINITIONS_VERSION must be a positive integer' unless definitions_floor&.positive?

  api = named(resources, 'Deployment', 'merchant-api')
  api_container = api&.dig('spec', 'template', 'spec', 'containers')&.find { |container| container['name'] == 'api' }
  raise ScannerContractError, 'Deployment/merchant-api container api is required' unless api_container
  require_config_map_reference(api_container, 'merchant-runtime')

  scanner = named(resources, 'Deployment', 'merchant-worker-scan')
  raise ScannerContractError, 'Deployment/merchant-worker-scan is required' unless scanner
  replicas = Integer(scanner.dig('spec', 'replicas'), exception: false)
  raise ScannerContractError, 'merchant-worker-scan replicas must be at least 2' unless replicas && replicas >= 2
  worker = scanner.dig('spec', 'template', 'spec', 'containers')&.find { |container| container['name'] == 'worker' }
  raise ScannerContractError, 'merchant-worker-scan container worker is required' unless worker
  require_config_map_reference(worker, 'merchant-runtime')
  require_config_key_environment(worker, 'ASSET_SCANNER_SERVICE_ID', 'merchant-runtime', 'ASSET_SCANNER_SERVICE_ID')
  minimum_ready = (worker['env'] || []).find { |entry| entry['name'] == 'SCANNER_MINIMUM_READY_INSTANCES' }
  raise ScannerContractError, 'SCANNER_MINIMUM_READY_INSTANCES must be at least 2' unless Integer(minimum_ready&.fetch('value', nil), exception: false).to_i >= 2

  internal_service = named(resources, 'Service', 'merchant-api-scanner-internal')
  raise ScannerContractError, 'Service/merchant-api-scanner-internal is required' unless internal_service
  raise ScannerContractError, 'merchant-api-scanner-internal must publish not-ready API addresses' unless internal_service.dig('spec', 'publishNotReadyAddresses') == 'true'
  public_service = named(resources, 'Service', 'merchant-api')
  if public_service&.dig('spec', 'publishNotReadyAddresses') == 'true'
    raise ScannerContractError, 'Service/merchant-api must not publish not-ready API addresses'
  end

  puts "scanner Kubernetes contract passed: service_id=#{service_id} replicas=#{replicas} definitions_floor=#{definitions_floor}"
rescue Psych::SyntaxError, EncodingError => error
  warn "invalid Kubernetes YAML: #{error.message}"
  exit 1
rescue ScannerContractError, Errno::ENOENT => error
  warn error.message
  exit 1
end
