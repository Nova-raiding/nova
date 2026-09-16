#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
[ "${ECS_PRODUCTION_COMPOSE_LAYERS_FILE+x}" != x ] || {
  echo 'ECS_PRODUCTION_COMPOSE_LAYERS_FILE override is forbidden; the production layer manifest is fixed' >&2
  exit 1
}
layers_file=infra/local/ecs-production-compose.layers

case "$layers_file" in
  /*|*..*) echo "ECS production Compose layers file must be a repository-relative path without '..': $layers_file" >&2; exit 1 ;;
esac

cd "$root"
[ -f "$layers_file" ] || { echo "ECS production Compose layers file not found: $layers_file" >&2; exit 1; }

set --
layer_count=0
previous=''
while IFS= read -r layer || [ -n "$layer" ]; do
  case "$layer" in
    '') echo "ECS production Compose layers file contains a blank entry" >&2; exit 1 ;;
    /*|*..*) echo "ECS production Compose layer must be a repository-relative path without '..': $layer" >&2; exit 1 ;;
    *auth-hardening*) echo "development auth-hardening overlay is forbidden in the ECS production chain: $layer" >&2; exit 1 ;;
  esac
  [ -f "$layer" ] || { echo "ECS production Compose layer not found: $layer" >&2; exit 1; }
  [ "$layer" != "$previous" ] || { echo "duplicate adjacent ECS production Compose layer: $layer" >&2; exit 1; }
  set -- "$@" -f "$layer"
  previous=$layer
  layer_count=$((layer_count + 1))
done < "$layers_file"

[ "$layer_count" -ge 2 ] || { echo 'ECS production Compose chain must contain at least a base and release layer' >&2; exit 1; }
first_layer=$(sed -n '1p' "$layers_file")
last_layer=$(tail -n 1 "$layers_file")
[ "$first_layer" = 'infra/local/docker-compose.yml' ] || { echo 'ECS production Compose base layer must be first' >&2; exit 1; }
[ "$last_layer" = 'infra/local/docker-compose.ecs-pilot-release.yml' ] || { echo 'ECS production release identity layer must be last' >&2; exit 1; }

docker compose --env-file .env "$@" config --format json
