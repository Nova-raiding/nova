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
