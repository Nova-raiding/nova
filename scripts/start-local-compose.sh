#!/bin/sh
set -eu

# The scanner uses an Ed25519 receipt key and the API must trust the matching
# public key.  Keep this bootstrap in the canonical compose entrypoint so a
# user who runs `npm run dev:stack` or invokes this script directly cannot
# accidentally start a red scanner with empty callback credentials.  The
# helper is local-only and refuses production profiles; it writes only the
# git-ignored, mode-0600 .env file and never prints key material.
sh scripts/ensure-local-scanner-key.sh

if [ -f .env ]; then
  exec docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build "$@"
fi

exec docker compose -f infra/local/docker-compose.yml up -d --build "$@"
