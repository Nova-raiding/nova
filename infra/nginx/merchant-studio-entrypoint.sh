#!/bin/sh
set -eu

: "${MERCHANT_WORKSPACE_ID:?MERCHANT_WORKSPACE_ID must be injected at container startup}"
case "$MERCHANT_WORKSPACE_ID" in
  *__MERCHANT_WORKSPACE_ID__*|''|*[!A-Za-z0-9._-]*|[.-]*)
    echo 'MERCHANT_WORKSPACE_ID must start with an alphanumeric character and contain only letters, numbers, dot, underscore, or hyphen' >&2
    exit 1
    ;;
esac
workspace_id_length=$(printf '%s' "$MERCHANT_WORKSPACE_ID" | awk '{print length}')
if [ "$workspace_id_length" -lt 1 ] || [ "$workspace_id_length" -gt 128 ]; then
  echo 'MERCHANT_WORKSPACE_ID must be between 1 and 128 characters' >&2
  exit 1
fi
MERCHANT_API_RESOLVER=${MERCHANT_API_RESOLVER:-$(awk '/^nameserver[[:space:]]+/{print $2; exit}' /etc/resolv.conf)}
if [ -z "$MERCHANT_API_RESOLVER" ]; then
  echo 'MERCHANT_API_RESOLVER could not be determined' >&2
  exit 1
fi
# Restrict envsubst to the runtime values so
# nginx's own $host/$scheme/$merchant_api_host variables remain intact.
tmp=/tmp/merchant-studio-nginx.conf
MERCHANT_WORKSPACE_ID="$MERCHANT_WORKSPACE_ID" MERCHANT_API_RESOLVER="$MERCHANT_API_RESOLVER" \
  envsubst '${MERCHANT_WORKSPACE_ID} ${MERCHANT_API_RESOLVER}' \
  < /etc/nginx/merchant-studio.conf.template > "$tmp"
mv "$tmp" /etc/nginx/conf.d/default.conf
