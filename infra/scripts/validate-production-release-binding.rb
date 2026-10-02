#!/usr/bin/env ruby
# frozen_string_literal: true

# Bind the rendered production configuration to the release selected by the
# deploy preflight.  This reads only the non-secret release_id field and emits
# stable diagnostics; it never prints configuration values or secret material.

require 'psych'

config_path, expected_release_id = ARGV
abort('production config path and expected release ID are required') unless config_path && expected_release_id
abort('production config path is not a regular file') unless File.file?(config_path) && !File.symlink?(config_path)
abort('expected release ID is invalid') unless expected_release_id.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/)

begin
  source = File.read(config_path, encoding: 'UTF-8')
  stream = Psych.parse_stream(source)
  documents = stream.children.reject { |document| document.root.nil? }
  abort('production config must contain exactly one YAML document') unless documents.length == 1
  document = Psych.safe_load(source, aliases: false)
  release_id = document.is_a?(Hash) ? document['release_id'] : nil
  abort('production config release_id is missing or invalid') unless release_id.is_a?(String) && release_id.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/)
  abort('production config release_id does not match the selected release') unless release_id == expected_release_id
rescue Psych::Exception, EncodingError
  abort('production config release identity binding could not be parsed')
end

puts 'production config release identity binding passed'
