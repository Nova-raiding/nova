#!/usr/bin/env ruby
# frozen_string_literal: true

require 'digest'
require 'json'
require 'yaml'

path, digest_json, mode = ARGV
abort('rendered ECS Compose path is required') unless path && File.file?(path)

begin
  document = YAML.safe_load(File.read(path), aliases: true)
  digests = JSON.parse(digest_json || '')
rescue StandardError => e
  abort("invalid ECS release input: #{e.message}")
end

required = {
  'merchant-api' => %w[api api-replica],
  'postgres-migration' => %w[migrate],
  'merchant-worker' => %w[worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan],
  'merchant-ui' => %w[ui],
  'merchant-ops-ui' => %w[ops-ui],
  'payment-gateway' => %w[payment-gateway],
  'pilot-gateway' => %w[pilot-gateway],
  'clamav' => %w[clamav]
}
services = document.is_a?(Hash) && document['services'].is_a?(Hash) ? document['services'] : {}
errors = []
oci_metadata = document['x-candidate-image-oci-metadata']
candidate_metadata = oci_metadata.is_a?(Hash)
if candidate_metadata && oci_metadata.keys.sort != required.keys.sort
  errors << 'candidate Compose OCI metadata must contain exactly the required image artifacts'
end

identity = nil
if candidate_metadata
  required.each_key do |artifact|
    entry = oci_metadata[artifact]
    labels = entry.is_a?(Hash) ? entry['labels'] : nil
    reference = entry.is_a?(Hash) ? entry['reference'] : nil
    digest = entry.is_a?(Hash) ? entry['digest'] : nil
    unless entry.is_a?(Hash) && labels.is_a?(Hash) && reference.is_a?(String) && digest.is_a?(String) &&
           labels['com.storenova.release.id'].is_a?(String) && labels['org.opencontainers.image.revision'].is_a?(String) &&
           labels['com.storenova.release.source_sha256'].is_a?(String) &&
           labels['org.opencontainers.image.revision'].match?(/\A[0-9a-f]{40}\z/) &&
           labels['com.storenova.release.source_sha256'].match?(/\Asha256:[0-9a-f]{64}\z/)
      errors << "#{artifact} OCI metadata is incomplete"
      next
    end
    identity ||= labels
    %w[com.storenova.release.id org.opencontainers.image.revision com.storenova.release.source_sha256].each do |key|
      errors << "#{artifact} OCI identity label #{key} differs across images" unless labels[key] == identity[key]
    end
    errors << "#{artifact} OCI metadata digest does not match its reference" unless reference.end_with?("@#{digest}")
  end
end

required.each do |artifact, service_names|
  digest = digests[artifact]
  unless digest.is_a?(String) && digest.match?(/\Asha256:[0-9a-f]{64}\z/)
    errors << "#{artifact} digest must be sha256 plus 64 lowercase hexadecimal characters"
    next
  end
  service_names.each do |service_name|
    service = services[service_name]
    if !service.is_a?(Hash)
      errors << "required ECS service is missing: #{service_name}"
      next
    end
    errors << "#{service_name} must not contain a build directive" if service.key?('build') && service['build']
    image = service['image']
    errors << "#{service_name} image must be an immutable repository@#{digest} reference" unless image.is_a?(String) && image.end_with?("@#{digest}")
    if candidate_metadata
      artifact_metadata = oci_metadata[artifact]
      unless artifact_metadata.is_a?(Hash) && artifact_metadata['reference'] == image && artifact_metadata['digest'] == digest
        errors << "#{service_name} image does not match injected OCI metadata"
      end
    else
      labels = service['labels']
      errors << "#{service_name} release id label does not match the ECS release contract" unless labels.is_a?(Hash) && labels['com.storenova.release.id'] == ENV['RELEASE_ID']
      errors << "#{service_name} release git label does not match the ECS release contract" unless labels.is_a?(Hash) && labels['org.opencontainers.image.revision'] == ENV['RELEASE_GIT_SHA']
    end
    if candidate_metadata && identity.is_a?(Hash)
      unless %w[RELEASE_ID RELEASE_GIT_SHA].all? { |key| ENV[key].nil? || identity[{ 'RELEASE_ID' => 'com.storenova.release.id', 'RELEASE_GIT_SHA' => 'org.opencontainers.image.revision' }[key]] == ENV[key] }
        errors << "#{service_name} OCI metadata does not match the frozen release environment"
      end
    end
  end
end

migration_image = services.dig('migrate', 'image')
unless migration_image.is_a?(String) && migration_image.match?(%r{(?:\A|/)postgres:17-alpine@sha256:[0-9a-f]{64}\z})
  errors << 'migrate image must be an immutable PostgreSQL 17 postgres:17-alpine image'
end

abort(errors.map { |error| "- #{error}" }.join("\n")) unless errors.empty?
canonical = required.keys.sort.map { |key| "#{key}=#{digests.fetch(key)}\n" }.join
image_set_digest = "sha256:#{Digest::SHA256.hexdigest(canonical)}"
release_environment_keys = %w[RELEASE_ID RELEASE_GIT_SHA RELEASE_MANIFEST_SHA256 RELEASE_IMAGE_SET_DIGEST]
contract = Marshal.load(Marshal.dump(document))
%w[api api-replica].each do |service_name|
  environment = contract.dig('services', service_name, 'environment')
  release_environment_keys.each { |key| environment.delete(key) } if environment.is_a?(Hash)
end
manifest_sha256 = Digest::SHA256.hexdigest(JSON.generate(contract))

if mode == '--print-image-set-digest'
  puts image_set_digest
elsif mode == '--print-manifest-sha256'
  puts manifest_sha256
else
  expected = {
    'RELEASE_ID' => ENV['RELEASE_ID'],
    'RELEASE_GIT_SHA' => ENV['RELEASE_GIT_SHA'],
    'RELEASE_MANIFEST_SHA256' => manifest_sha256,
    'RELEASE_IMAGE_SET_DIGEST' => image_set_digest
  }
  %w[api api-replica].each do |service_name|
    environment = services.dig(service_name, 'environment') || {}
    expected.each { |key, value| errors << "#{service_name} #{key} does not match the ECS release contract" unless value && environment[key] == value }
  end
  abort(errors.map { |error| "- #{error}" }.join("\n")) unless errors.empty?
  puts "ECS Compose release gate passed: services=#{required.values.flatten.length} image_set_digest=#{image_set_digest} manifest_sha256=#{manifest_sha256} manifest=#{path}"
end
