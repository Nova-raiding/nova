#!/usr/bin/env bash
set -euo pipefail

# Rotate the Alipay application private key and Alipay platform public key on
# the ECS pilot host without ever printing secret material.
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <app-private-key-file> <alipay-public-key-file> [app-public-key-file]" >&2
  exit 2
fi

readonly gateway_uid=100
readonly gateway_gid=101
readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly repo_root="$(cd -- "$script_dir/../.." && pwd -P)"
env_file="${ENV_FILE:-$repo_root/.env}"
if [[ "$env_file" != /* ]]; then
  env_file="$(pwd -P)/$env_file"
fi

fail() {
  echo "$1" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail 'secret rotation must run as root so gateway ownership can be enforced'
for command_name in openssl docker curl install chown chmod cp mktemp od tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is unavailable: $command_name"
done
[[ -f "$env_file" && -r "$env_file" ]] || fail "compose env file is missing or unreadable: $env_file"
[[ -f "$repo_root/infra/local/docker-compose.yml" ]] || fail "compose file is missing under repository root: $repo_root"
[[ -f "$repo_root/infra/local/docker-compose.ecs-pilot.yml" ]] || fail "pilot compose overlay is missing under repository root: $repo_root"
[[ -f "$repo_root/services/payment-gateway/Dockerfile" ]] || fail "payment-gateway Dockerfile is missing under repository root: $repo_root"

app_private="$1"
alipay_public="$2"
app_public="${3:-}"
target_dir="/opt/merchant-deploy/deploy/secrets"
target_private="$target_dir/alipay_app_private_key"
target_public="$target_dir/alipay_public_key"

[[ -f "$app_private" && ! -L "$app_private" && -r "$app_private" ]] || fail "private key must be a readable regular file: $app_private"
[[ -f "$alipay_public" && ! -L "$alipay_public" && -r "$alipay_public" ]] || fail "public key must be a readable regular file: $alipay_public"
[[ ! -L "$target_dir" ]] || fail "secret directory must not be a symlink: $target_dir"
[[ ! -L "$target_private" && ! -L "$target_public" ]] || fail 'existing secret targets must not be symlinks'

cd "$repo_root"
compose=(docker compose --env-file "$env_file" -f infra/local/docker-compose.yml -f infra/local/docker-compose.ecs-pilot.yml)
# Render first so missing required compose variables abort before any key file
# is replaced. Compose reads exported variables in addition to ENV_FILE; this
# allows the deployment operator to supply runtime-only values without
# putting them in the repository env file.
if ! "${compose[@]}" config --quiet >/dev/null 2>&1; then
  fail 'compose configuration is invalid; provide all required non-secret deployment variables'
fi

openssl pkey -in "$app_private" -check -noout >/dev/null 2>&1 || {
  fail 'invalid Alipay application private key'
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/alipay-rotate.XXXXXXXX")"
trap 'rm -rf -- "$tmp_dir"' EXIT
validate_public_key() {
  local key_file="$1"
  if openssl pkey -pubin -in "$key_file" -noout >/dev/null 2>&1; then
    return 0
  fi
  if openssl x509 -pubkey -noout -in "$key_file" >/dev/null 2>&1; then
    return 0
  fi
  # Runtime normalizePublicKey also accepts bare base64 DER. Decode into a
  # private temporary file and validate the resulting SubjectPublicKeyInfo.
  local der_file="$tmp_dir/public.der"
  openssl base64 -d -A -in "$key_file" -out "$der_file" >/dev/null 2>&1 || return 1
  openssl pkey -pubin -inform DER -in "$der_file" -noout >/dev/null 2>&1
}
validate_public_key "$alipay_public" || fail 'invalid Alipay public key or certificate'

if [[ -n "$app_public" ]]; then
  [[ -f "$app_public" && ! -L "$app_public" && -r "$app_public" ]] || fail "application public key must be a readable regular file: $app_public"
  private_fingerprint="$(openssl pkey -in "$app_private" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n')"
  public_fingerprint="$(openssl pkey -pubin -in "$app_public" -outform DER 2>/dev/null | openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n' || true)"
  if [[ -z "$public_fingerprint" ]]; then
    public_fingerprint="$(openssl x509 -pubkey -noout -in "$app_public" 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' \n' || true)"
  fi
  if [[ -z "$public_fingerprint" ]]; then
    app_public_der="$tmp_dir/app-public.der"
    if openssl base64 -d -A -in "$app_public" -out "$app_public_der" >/dev/null 2>&1 && openssl pkey -pubin -inform DER -in "$app_public_der" -outform DER -out "$tmp_dir/app-public-spki.der" >/dev/null 2>&1; then
      public_fingerprint="$(openssl dgst -sha256 -binary "$tmp_dir/app-public-spki.der" | od -An -tx1 | tr -d ' \n')"
    fi
  fi
  [[ -n "$public_fingerprint" && "$private_fingerprint" == "$public_fingerprint" ]] || fail 'application private/public key pair does not match'
fi

install -d "$target_dir"
# Keep the directory non-writable by the gateway process.  It needs traversal
# and read access to the mounted keys, while root retains exclusive control of
# rotation and backups.
chown "0:$gateway_gid" "$target_dir"
chmod 750 "$target_dir"
stamp="$(date -u +%Y%m%d%H%M%S)-$$"
for target in "$target_private" "$target_public"; do
  if [[ -f "$target" ]]; then
    cp -p "$target" "$target.$stamp.bak"
    chown 0:0 "$target.$stamp.bak"
    chmod 600 "$target.$stamp.bak"
  fi
done
install -o "$gateway_uid" -g "$gateway_gid" -m 640 "$app_private" "$target_private"
install -o "$gateway_uid" -g "$gateway_gid" -m 640 "$alipay_public" "$target_public"

"${compose[@]}" up -d --no-deps --build payment-gateway

curl -fsS --retry 10 --retry-delay 2 -o /dev/null https://yxsona.com/payment-gateway/healthz
echo "Alipay secrets rotated and payment-gateway health check passed"
