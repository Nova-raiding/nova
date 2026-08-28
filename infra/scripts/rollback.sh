#!/bin/sh
set -eu
: "${ROLLBACK_COMMAND:?ROLLBACK_COMMAND is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${CONFIRM_ROLLBACK:?Set CONFIRM_ROLLBACK=YES to rollback}"
[ "$CONFIRM_ROLLBACK" = YES ] || { echo "rollback refused" >&2; exit 2; }
printf '%s\n' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "RELEASE_ID contains unsafe characters" >&2; exit 1; }
sh -c "$ROLLBACK_COMMAND '$RELEASE_ID'"
echo "rollback command completed; verify health, migrations, queues and unknown jobs"
