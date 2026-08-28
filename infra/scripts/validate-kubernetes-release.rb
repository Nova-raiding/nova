# frozen_string_literal: true

require 'psych'

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
  Namespace ConfigMap Secret Service Ingress NetworkPolicy
  PodDisruptionBudget HorizontalPodAutoscaler VerticalPodAutoscaler
  ServiceAccount Role RoleBinding ClusterRole ClusterRoleBinding
  PersistentVolume PersistentVolumeClaim StorageClass
].freeze

CONTAINER_FIELDS = %w[containers initContainers ephemeralContainers].freeze
IMAGE_PATTERN = /\A[^\s@]+@sha256:[0-9a-f]{64}\z/i.freeze
DIGEST_PATTERN = /\Asha256:[0-9a-f]{64}\z/i.freeze

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

def validate_image(image, expected_digest, context)
  raise ReleaseManifestError, "#{context}.image is required" unless image.is_a?(String) && !image.empty?
  raise ReleaseManifestError, "unresolved or mutable image reference at #{context}: #{image}" if image.include?('REPLACE_ME') || image.match?(/:latest(?:@|\z)/)
  raise ReleaseManifestError, "image must use an immutable sha256 digest at #{context}: #{image}" unless image.match?(IMAGE_PATTERN)

  image_digest = image.split('@', 2).last
  raise ReleaseManifestError, "image digest does not match IMAGE_DIGEST at #{context}: #{image}" unless image_digest == expected_digest
end

def validate_pod_spec(pod_spec, expected_digest, context)
  raise ReleaseManifestError, "#{context} must be a mapping" unless pod_spec.is_a?(Hash)

  containers = pod_spec['containers']
  raise ReleaseManifestError, "#{context}.containers must be a non-empty array" unless containers.is_a?(Array) && !containers.empty?

  image_count = 0
  CONTAINER_FIELDS.each do |field|
    next unless pod_spec.key?(field)

    entries = pod_spec[field]
    raise ReleaseManifestError, "#{context}.#{field} must be an array" unless entries.is_a?(Array)

    entries.each_with_index do |container, index|
      raise ReleaseManifestError, "#{context}.#{field}[#{index}] must be a mapping" unless container.is_a?(Hash)

      name = container['name']
      label = name.is_a?(String) && !name.empty? ? name : index.to_s
      validate_image(container['image'], expected_digest, "#{context}.#{field}[#{label}]")
      image_count += 1
    end
  end
  image_count
end

def validate_resource(resource, expected_digest, context)
  raise ReleaseManifestError, "#{context} must be a Kubernetes object" unless resource.is_a?(Hash)

  api_version = resource['apiVersion']
  kind = resource['kind']
  raise ReleaseManifestError, "#{context}.apiVersion is required" unless api_version.is_a?(String) && !api_version.empty?
  raise ReleaseManifestError, "#{context}.kind is required" unless kind.is_a?(String) && !kind.empty?

  if kind == 'List'
    items = resource['items']
    raise ReleaseManifestError, "#{context}.items must be a non-empty array" unless items.is_a?(Array) && !items.empty?
    return items.each_with_index.sum { |item, index| validate_resource(item, expected_digest, "#{context}.items[#{index}]") }
  end

  pod_spec_path = WORKLOAD_POD_SPEC_PATHS[kind]
  return 0 if NON_WORKLOAD_KINDS.include?(kind)
  raise ReleaseManifestError, "unsupported Kubernetes resource kind: #{kind}" unless pod_spec_path

  name = resource.dig('metadata', 'name')
  workload = name.is_a?(String) && !name.empty? ? "#{kind}/#{name}" : "#{context}(#{kind})"
  pod_spec = nested_hash(resource, pod_spec_path, workload)
  validate_pod_spec(pod_spec, expected_digest, "#{workload}.#{pod_spec_path.join('.')}")
end

begin
  manifest_path, expected_digest = ARGV
  raise ReleaseManifestError, 'rendered Kubernetes manifest path is required' unless manifest_path && !manifest_path.empty?
  raise ReleaseManifestError, 'expected image digest is required' unless expected_digest && !expected_digest.empty?
  raise ReleaseManifestError, 'expected image digest must be sha256 plus exactly 64 hexadecimal characters' unless expected_digest.match?(DIGEST_PATTERN)

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

  image_count = documents.each_with_index.sum { |document, index| validate_resource(document, expected_digest, "document[#{index}]") }
  raise ReleaseManifestError, 'rendered Kubernetes manifest contains no supported workload container image' if image_count.zero?

  puts "Kubernetes release manifest gate passed: images=#{image_count} digest=#{expected_digest} manifest=#{manifest_path}"
rescue ReleaseManifestError => error
  warn error.message
  exit 1
end
