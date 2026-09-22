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

# Production credentials must live outside the mutable checkout. Keep the
# historical .env fallback only for non-production local contract renders.
production_context=false
[ "${NODE_ENV:-}" = production ] && production_context=true
[ "${DEPLOYMENT_PROFILE:-}" = ecs ] && production_context=true
[ -f "$root/.candidate-identity" ] && production_context=true
if [ "${ECS_PRODUCTION_ENV_FILE+x}" = x ]; then
  production_env=$ECS_PRODUCTION_ENV_FILE
  case "$production_env" in
    /*) ;;
    *) echo 'ECS_PRODUCTION_ENV_FILE must be an absolute path' >&2; exit 1 ;;
  esac
  [ -f "$production_env" ] && [ ! -L "$production_env" ] || {
    echo 'ECS_PRODUCTION_ENV_FILE must be a regular non-symlink file' >&2
    exit 1
  }
  production_env_parent=$(CDPATH='' cd -- "$(dirname "$production_env")" 2>/dev/null && pwd -P) || {
    echo 'ECS_PRODUCTION_ENV_FILE parent must be a canonical directory' >&2
    exit 1
  }
  [ "$production_env_parent/$(basename "$production_env")" = "$production_env" ] || {
    echo 'ECS_PRODUCTION_ENV_FILE must not traverse symlinked or non-canonical parents' >&2
    exit 1
  }
  protected_parent=$production_env_parent
  while [ "$protected_parent" != / ]; do
    parent_owner=$(stat -c '%u' "$protected_parent" 2>/dev/null || stat -f '%u' "$protected_parent")
    parent_mode=$(stat -c '%a' "$protected_parent" 2>/dev/null || stat -f '%Lp' "$protected_parent")
    [ "$parent_owner" = 0 ] || {
      echo 'ECS_PRODUCTION_ENV_FILE parent chain must be root-owned' >&2
      exit 1
    }
    case "$parent_mode" in
      *[2367][0-7]|*[2367])
        echo 'ECS_PRODUCTION_ENV_FILE parent chain must not be group/other writable' >&2
        exit 1
        ;;
    esac
    protected_parent=$(dirname "$protected_parent")
  done
  env_owner=$(stat -c '%u' "$production_env" 2>/dev/null || stat -f '%u' "$production_env")
  env_mode=$(stat -c '%a' "$production_env" 2>/dev/null || stat -f '%Lp' "$production_env")
  [ "$env_owner" = 0 ] && [ "$env_mode" = 600 ] || {
    echo 'ECS_PRODUCTION_ENV_FILE must be root-owned with mode 600' >&2
    exit 1
  }
  root_real=$(CDPATH='' cd -- "$root" && pwd -P)
  case "$production_env" in
    "$root_real"|"$root_real"/*) echo 'ECS_PRODUCTION_ENV_FILE must be outside the mutable repository' >&2; exit 1 ;;
  esac
else
  [ "$production_context" = false ] || {
    echo 'ECS_PRODUCTION_ENV_FILE is required for production Compose rendering' >&2
    exit 1
  }
  production_env=.env
fi

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

docker compose --env-file "$production_env" "$@" config --format json
