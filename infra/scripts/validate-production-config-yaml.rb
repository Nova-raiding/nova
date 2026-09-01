#!/usr/bin/env ruby
# frozen_string_literal: true

require 'yaml'

path = ARGV.fetch(0)
begin
  document = Psych.parse_file(path)
rescue Psych::Exception
  warn 'production config is not valid YAML'
  exit 1
end

def walk(node)
  if node.is_a?(Psych::Nodes::Alias) || (node.respond_to?(:anchor) && node.anchor)
    warn 'production config YAML aliases are forbidden'
    exit 1
  end
  case node
  when Psych::Nodes::Document, Psych::Nodes::Sequence
    node.children.each { |child| walk(child) }
  when Psych::Nodes::Mapping
    seen = {}
    node.children.each_slice(2) do |key, value|
      key_name = key.respond_to?(:value) ? key.value : nil
      if key_name && seen[key_name]
        warn 'production config contains a duplicate YAML key'
        exit 1
      end
      seen[key_name] = true if key_name
      walk(key)
      walk(value)
    end
  end
end

walk(document)

begin
  config = YAML.safe_load(File.read(path, encoding: 'UTF-8'), aliases: false)
rescue Psych::Exception
  warn 'production config is not valid YAML'
  exit 1
end
if config.nil?
  warn 'required production config key is missing: plugin_enabled'
  exit 1
end
unless config.is_a?(Hash)
  warn 'production config must be a YAML mapping'
  exit 1
end

required_keys = ENV.fetch('REQUIRED_PRODUCTION_CONFIG_KEYS', '').split
missing_required_key = required_keys.find { |key| !config.key?(key) }
if missing_required_key
  warn "required production config key is missing: #{missing_required_key}"
  exit 1
end

unsafe_placeholder = /(?:SET_[A-Z0-9_]+|BLOCKED_UNTIL_|\$\{[^}]+\}|\b(?:REPLACE_ME|CHANGE_ME|TODO|TBD)\b)/
contains_unsafe_scalar = lambda do |value|
  case value
  when Hash
    value.any? { |key, child| contains_unsafe_scalar.call(key) || contains_unsafe_scalar.call(child) }
  when Array
    value.any? { |child| contains_unsafe_scalar.call(child) }
  when String
    normalized = value.downcase
    value.match?(unsafe_placeholder) || normalized.include?('pilot-local-token') ||
      normalized.include?('localhost') || normalized.include?('127.0.0.1') ||
      normalized.include?('model-relay.example.com')
  else
    false
  end
end
if contains_unsafe_scalar.call(config)
  warn 'production config contains unresolved placeholder or local-only value'
  exit 1
end

def path_present?(config, path)
  cursor = config
  path.each do |segment|
    return false unless cursor.is_a?(Hash) && cursor.key?(segment)
    cursor = cursor[segment]
  end
  !(cursor.nil? || cursor.is_a?(Hash) || cursor.is_a?(Array))
end

def path_value(config, path)
  path.reduce(config) { |cursor, segment| cursor.fetch(segment) }
end

public_origins = {}
{
  'app_base_url' => %w[public_endpoints app_base_url],
  'ops_base_url' => %w[public_endpoints ops_base_url],
  'mcp_base_url' => %w[codex mcp base_url],
}.each do |flat_key, nested_path|
  sources = [config.key?(flat_key), path_present?(config, nested_path)].count(true)
  if sources.zero?
    warn "required production config key is missing: #{flat_key}"
    exit 1
  end
  if sources > 1
    warn "production config key is ambiguous: #{flat_key}"
    exit 1
  end
  value = config.key?(flat_key) ? config[flat_key] : path_value(config, nested_path)
  unless value.is_a?(String) && value.match?(/\Ahttps:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/?\z/)
    warn "#{flat_key} must be a canonical HTTPS origin"
    exit 1
  end
  public_origins[flat_key] = value.sub(%r{/$}, '')
end

if public_origins['mcp_base_url'] != public_origins['app_base_url']
  warn 'mcp_base_url must exactly match app_base_url because the plugin appends /mcp'
  exit 1
end
if public_origins['ops_base_url'] == public_origins['app_base_url']
  warn 'ops_base_url must use a distinct origin'
  exit 1
end

puts public_origins['mcp_base_url'] if ARGV.include?('--print-mcp-base-url')
