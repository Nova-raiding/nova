#!/bin/sh
set -eu

root=$1 release_id=$2 git_sha=$3
identity="$root/.candidate-identity"
[ -f "$identity" ] && [ ! -L "$identity" ] || { echo 'cloud candidate identity is missing or unsafe' >&2; exit 2; }
field() {
  key=$1
  [ "$(awk -F= -v key="$key" '$1 == key { count++ } END { print count+0 }' "$identity")" -eq 1 ] || { echo "cloud candidate identity needs exactly one $key" >&2; exit 2; }
  sed -n "s/^${key}=//p" "$identity"
}
[ "$(field schema_version)" = candidate-identity/2 ] || { echo 'cloud candidate identity schema mismatch' >&2; exit 2; }
[ "$(field release_id)" = "$release_id" ] && [ "$(field git_sha)" = "$git_sha" ] || { echo 'cloud candidate identity release or Git SHA mismatch' >&2; exit 2; }
key_id=$(field plugin_key_id)
public_key=/run/release-security/plugin-trust/plugin-release-public.pem
key_id_path=/run/release-security/plugin-trust/key-id
for file in "$public_key" "$key_id_path"; do
  [ -f "$file" ] && [ ! -L "$file" ] || { echo 'protected plugin trust anchor is missing or unsafe' >&2; exit 2; }
done
python3 <<'PY'
import pathlib, stat
for name in ('plugin-release-public.pem', 'key-id'):
    path = pathlib.Path('/run/release-security/plugin-trust') / name
    for entry in (path, path.parent, path.parent.parent):
        item = entry.lstat()
        if item.st_uid != 0 or item.st_mode & (stat.S_IWGRP | stat.S_IWOTH) or stat.S_ISLNK(item.st_mode):
            raise SystemExit(f'plugin trust path is not root-owned and protected: {entry}')
PY
[ "$key_id" = "$(sed -n '1p' "$key_id_path")" ] || { echo 'plugin key ID differs from protected trust' >&2; exit 2; }
darwin_bridge=
for os in darwin win32; do
  descriptor="$root/.plugin-release-descriptor-${os}.json"
  tests="$root/.local-plugin-test-attestation-${os}.json"
  for file in "$descriptor" "$tests"; do
    [ -f "$file" ] && [ ! -L "$file" ] || { echo "cloud $os plugin input is missing or unsafe: $file" >&2; exit 2; }
  done
  descriptor_hash=$(shasum -a 256 "$descriptor" | awk '{print $1}')
  test_hash=$(shasum -a 256 "$tests" | awk '{print $1}')
  [ "$(field "plugin_${os}_descriptor_sha256")" = "sha256:$descriptor_hash" ] || { echo "cloud $os plugin descriptor digest mismatch" >&2; exit 2; }
  [ "$(field "plugin_${os}_test_sha256")" = "sha256:$test_hash" ] || { echo "cloud $os plugin test digest mismatch" >&2; exit 2; }
  node "$root/scripts/plugin-release-descriptor.mjs" verify-cloud \
    --descriptor "$descriptor" --public-key "$public_key" --key-id "$key_id" \
    --release-id "$release_id" --git-sha "$git_sha" >&2
  plugin_platform=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.platform)' "$descriptor")
  case "$plugin_platform" in "$os"-x64|"$os"-arm64) ;; *) echo "cloud $os plugin platform mismatch" >&2; exit 2 ;; esac
  node "$root/scripts/local-plugin-test-attestation.mjs" verify \
    --record "$tests" --descriptor "$descriptor" --public-key "$public_key" \
    --key-id "$key_id" --release-id "$release_id" --git-sha "$git_sha" --platform "$plugin_platform" >&2
  bridge=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!/^[a-f0-9]{64}$/.test(x.bridge_sha256))process.exit(2);process.stdout.write(x.bridge_sha256)' "$descriptor")
  if [ "$os" = darwin ]; then darwin_bridge=$bridge
  elif [ "$bridge" != "$darwin_bridge" ]; then echo 'macOS and Windows plugin bridge hashes differ' >&2; exit 2
  fi
done
printf '%s' "$darwin_bridge"
