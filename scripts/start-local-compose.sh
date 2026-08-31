#!/bin/sh
set -eu

if [ -f .env ]; then
  exec docker compose --env-file .env -f infra/local/docker-compose.yml up -d "$@"
fi

exec docker compose -f infra/local/docker-compose.yml up -d "$@"
