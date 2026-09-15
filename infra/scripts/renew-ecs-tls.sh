#!/usr/bin/env bash
set -euo pipefail

cert_dir="${MERCHANT_TLS_CERT_DIR:-/opt/merchant-deploy/deploy/certs}"
webroot="${MERCHANT_TLS_WEBROOT:-/opt/merchant-deploy/deploy/acme-webroot}"
evidence_root="${MERCHANT_TLS_EVIDENCE_ROOT:-/opt/merchant-validation}"
gateway="${MERCHANT_TLS_GATEWAY_CONTAINER:-}"
certbot_image="${MERCHANT_CERTBOT_IMAGE:-certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20}"
required_hosts=(yxsona.com www.yxsona.com admin.yxsona.com ops.yxsona.com alerts.yxsona.com)

if [[ -z "$gateway" ]]; then
  mapfile -t gateways < <(docker ps --filter 'name=local-pilot-gateway-https' --format '{{.Names}}')
  [[ ${#gateways[@]} -eq 1 ]] || {
    echo "expected exactly one running TLS gateway, found ${#gateways[@]}" >&2
    exit 1
  }
  gateway="${gateways[0]}"
fi

gateway_uid="$(docker inspect "$gateway" --format '{{.Config.User}}')"
[[ "$gateway_uid" =~ ^[0-9]+$ ]] || {
  echo "TLS gateway must declare a numeric runtime UID, got: $gateway_uid" >&2
  exit 1
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
evidence="$evidence_root/${stamp}-tls-renew"
live="$cert_dir/live/yxsona.com"
install -d -m 700 "$evidence"
install -d -m 755 "$webroot/.well-known/acme-challenge"

before_serial="$(openssl x509 -in "$cert_dir/fullchain.pem" -noout -serial)"

(
  while :; do
    for token in "$webroot"/.well-known/acme-challenge/*; do
      [[ -f "$token" ]] || continue
      docker cp "$token" "$gateway:/tmp/acme/.well-known/acme-challenge/$(basename "$token")" >/dev/null 2>&1 || true
    done
    sleep 0.2
  done
) &
watcher=$!
trap 'kill "$watcher" 2>/dev/null || true' EXIT INT TERM

docker run --rm \
  -v "$cert_dir:/etc/letsencrypt" \
  -v "$webroot:/var/www/acme" \
  "$certbot_image" renew --no-random-sleep-on-renew --cert-name yxsona.com "$@" \
  >"$evidence/certbot.stdout" 2>"$evidence/certbot.stderr"

kill "$watcher" 2>/dev/null || true
wait "$watcher" 2>/dev/null || true
trap - EXIT INT TERM

after_serial="$(openssl x509 -in "$live/fullchain.pem" -noout -serial)"
printf 'before=%s\nafter=%s\n' "$before_serial" "$after_serial" >"$evidence/serials.txt"

# A normal timer invocation commonly finds no certificate due for renewal.
[[ "$before_serial" != "$after_serial" ]] || {
  chmod 600 "$evidence"/*
  exit 0
}

for host in "${required_hosts[@]}"; do
  openssl x509 -in "$live/cert.pem" -noout -checkhost "$host"
done >"$evidence/host-checks.txt"

cert_key="$(openssl x509 -in "$live/fullchain.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | awk '{print $1}')"
private_key="$(openssl pkey -in "$live/privkey.pem" -pubout -outform DER | sha256sum | awk '{print $1}')"
[[ "$cert_key" == "$private_key" ]] || {
  echo "renewed certificate/private key mismatch" >&2
  exit 1
}
printf 'certificate=%s\nprivate_key=%s\n' "$cert_key" "$private_key" >"$evidence/key-match.txt"

openssl verify -CAfile /etc/pki/tls/certs/ca-bundle.crt -untrusted "$live/chain.pem" "$live/cert.pem" \
  >"$evidence/chain-verify.txt"

install -m 644 "$live/fullchain.pem" "$cert_dir/.fullchain.pem.new"
install -m 600 "$live/privkey.pem" "$cert_dir/.privkey.pem.new"
chown root:root "$cert_dir/.fullchain.pem.new"
chown "$gateway_uid:$gateway_uid" "$cert_dir/.privkey.pem.new"
mv "$cert_dir/fullchain.pem" "$cert_dir/.fullchain.pem.previous"
mv "$cert_dir/privkey.pem" "$cert_dir/.privkey.pem.previous"
mv "$cert_dir/.fullchain.pem.new" "$cert_dir/fullchain.pem"
mv "$cert_dir/.privkey.pem.new" "$cert_dir/privkey.pem"

rollback() {
  rm -f "$cert_dir/fullchain.pem" "$cert_dir/privkey.pem"
  mv "$cert_dir/.fullchain.pem.previous" "$cert_dir/fullchain.pem"
  mv "$cert_dir/.privkey.pem.previous" "$cert_dir/privkey.pem"
  docker exec "$gateway" nginx -s reload >/dev/null 2>&1 || true
}

docker exec "$gateway" nginx -t >"$evidence/nginx-test.txt" 2>&1 || {
  rollback
  exit 1
}
docker exec "$gateway" nginx -s reload >"$evidence/nginx-reload.txt" 2>&1 || {
  rollback
  exit 1
}

rm -f "$cert_dir/.fullchain.pem.previous" "$cert_dir/.privkey.pem.previous"
sha256sum "$cert_dir/fullchain.pem" "$cert_dir/privkey.pem" >"$evidence/installed.sha256"
chmod 600 "$evidence"/*
