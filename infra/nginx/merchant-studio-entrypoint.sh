#!/bin/sh
set -eu

: "${MERCHANT_API_TOKEN:?MERCHANT_API_TOKEN must be injected at container startup}"
MERCHANT_API_RESOLVER=${MERCHANT_API_RESOLVER:-$(awk '/^nameserver[[:space:]]+/{print $2; exit}' /etc/resolv.conf)}
if [ -z "$MERCHANT_API_RESOLVER" ]; then
  echo 'MERCHANT_API_RESOLVER could not be determined' >&2
  exit 1
fi
case "$MERCHANT_API_TOKEN" in
  *__MERCHANT_API_TOKEN__*)
    echo 'MERCHANT_API_TOKEN contains an invalid placeholder or newline' >&2
    exit 1
    ;;
esac
token_without_newlines=$(printf '%s' "$MERCHANT_API_TOKEN" | tr -d '\r\n')
if [ "$token_without_newlines" != "$MERCHANT_API_TOKEN" ]; then
  echo 'MERCHANT_API_TOKEN contains an invalid placeholder or newline' >&2
  exit 1
fi

# The token is an opaque secret. Restrict envsubst to the runtime values so
# nginx's own $host/$scheme/$merchant_api_host variables remain intact.
tmp=/tmp/merchant-studio-nginx.conf
MERCHANT_API_TOKEN="$MERCHANT_API_TOKEN" MERCHANT_API_RESOLVER="$MERCHANT_API_RESOLVER" \
  envsubst '${MERCHANT_API_TOKEN} ${MERCHANT_API_RESOLVER}' \
  < /etc/nginx/merchant-studio.conf.template > "$tmp"
mv "$tmp" /etc/nginx/conf.d/default.conf
