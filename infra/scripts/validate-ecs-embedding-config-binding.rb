#!/usr/bin/env ruby
# frozen_string_literal: true

# Read-only check that the release config and the already-rendered ECS Compose
# describe the same embedding runtime. Never prints credentials or writes files.
require 'json'
require 'psych'
require 'bigdecimal'

class EmbeddingBindingError < StandardError; end

def fail_binding(message)
  raise EmbeddingBindingError, message
end

def one_yaml_mapping(path)
  source = File.read(path, encoding: 'UTF-8')
  stream = Psych.parse_stream(source)
  fail_binding('production config must contain exactly one YAML document') unless stream.children.length == 1
  mapping = stream.children.first.root
  fail_binding('production config must be a YAML mapping') unless mapping.is_a?(Psych::Nodes::Mapping)
  keys = mapping.children.each_slice(2).map(&:first)
  fail_binding('production config contains duplicate top-level keys') unless keys.all? { |key| key.is_a?(Psych::Nodes::Scalar) } && keys.map(&:value).uniq.length == keys.length
  value = Psych.safe_load(source, permitted_classes: [], permitted_symbols: [], aliases: false)
  fail_binding('production config must be a YAML mapping') unless value.is_a?(Hash)
  value
end

def environment(services, name)
  service = services[name]
  fail_binding("#{name} service is missing") unless service.is_a?(Hash)
  env = service['environment']
  fail_binding("#{name}.environment must be a rendered mapping") unless env.is_a?(Hash)
  env
end

def runtime_string(env, service, key)
  value = env[key]
  fail_binding("#{service}.#{key} must be a rendered string") unless value.is_a?(String)
  value
end

def matching(env, service, key, expected)
  fail_binding("#{service}.#{key} differs from production config") unless runtime_string(env, service, key) == expected
end

def positive_money(value)
  literal = value.is_a?(String) ? value.strip : value.to_s
  fail_binding('embedding_max_request_cny must be a positive decimal') unless literal.match?(/\A(?:0|[1-9]\d*)(?:\.\d{1,6})?\z/)
  number = BigDecimal(literal)
  fail_binding('embedding_max_request_cny must be a positive decimal') unless number.positive?
  number
end

def validate(config, rendered)
  services = rendered['services']
  fail_binding('rendered Compose must contain services') unless services.is_a?(Hash)
  enabled = config['knowledge_vector_index_enabled']
  fail_binding('knowledge_vector_index_enabled must be a YAML boolean') unless enabled == true || enabled == false
  expected_flag = enabled ? 'true' : 'false'
  api = environment(services, 'api')
  replica = environment(services, 'api-replica')
  automation = environment(services, 'worker-automation')
  { 'api' => api, 'api-replica' => replica, 'worker-automation' => automation }.each do |name, env|
    matching(env, name, 'KNOWLEDGE_VECTOR_INDEX_ENABLED', expected_flag)
  end
  %w[worker-sync worker-generation worker-publish worker-reconcile worker-scan].each do |name|
    env = environment(services, name)
    flag = env['KNOWLEDGE_VECTOR_INDEX_ENABLED']
    fail_binding("#{name}.KNOWLEDGE_VECTOR_INDEX_ENABLED must be absent or false") unless flag.nil? || flag == 'false'
  end
  return unless enabled

  model = config['embedding_model']
  fail_binding('embedding_model must be an approved model') unless %w[qwen3.7-text-embedding-flash qwen3.7-text-embedding].include?(model)
  dimension = config['embedding_dimensions'].to_s
  fail_binding('embedding_dimensions must equal 1024') unless dimension == '1024'
  budget = positive_money(config['embedding_max_request_cny'])
  relay = config['model_relay_base_url']
  fail_binding('model_relay_base_url must be a non-empty string') unless relay.is_a?(String) && !relay.empty?

  { 'api' => api, 'api-replica' => replica, 'worker-automation' => automation }.each do |name, env|
    matching(env, name, 'EMBEDDING_MODEL', model)
    matching(env, name, 'EMBEDDING_DIMENSIONS', dimension)
    matching(env, name, 'MODEL_RELAY_BASE_URL', relay)
    fail_binding("#{name}.EMBEDDING_VERSION is required") if runtime_string(env, name, 'EMBEDDING_VERSION').strip.empty?
    fail_binding("#{name}.MODEL_RELAY_API_KEY is required") if runtime_string(env, name, 'MODEL_RELAY_API_KEY').strip.empty?
  end
  %w[EMBEDDING_VERSION MODEL_RELAY_ALLOWED_HOSTS MODEL_RELAY_API_KEY].each do |key|
    matching(replica, 'api-replica', key, runtime_string(api, 'api', key))
    matching(automation, 'worker-automation', key, runtime_string(api, 'api', key))
  end
  %w[api api-replica].each do |name|
    env = name == 'api' ? api : replica
    actual_budget = positive_money(runtime_string(env, name, 'MODEL_EMBEDDING_MAX_REQUEST_CNY'))
    fail_binding("#{name}.MODEL_EMBEDDING_MAX_REQUEST_CNY differs from production config") unless actual_budget == budget
    matching(env, name, 'MODEL_RELAY_EMBEDDING_COST_EVIDENCE', 'true')
  end
end

begin
  config_path, compose_path = ARGV
  fail_binding('usage: validate-ecs-embedding-config-binding.rb CONFIG_YAML RENDERED_COMPOSE_JSON') unless config_path && compose_path && ARGV.length == 2
  config = one_yaml_mapping(config_path)
  rendered = JSON.parse(File.read(compose_path, encoding: 'UTF-8'))
  fail_binding('rendered Compose must be a JSON object') unless rendered.is_a?(Hash)
  validate(config, rendered)
  puts 'ECS embedding config and rendered Compose binding passed'
rescue EmbeddingBindingError => error
  warn "ECS_EMBEDDING_CONFIG_BINDING_INVALID: #{error.message}"
  exit 1
rescue Psych::Exception, JSON::ParserError, Errno::ENOENT, Errno::EACCES, ArgumentError
  warn 'ECS_EMBEDDING_CONFIG_BINDING_INVALID: config or rendered Compose could not be read or parsed'
  exit 1
end
