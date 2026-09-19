#!/usr/bin/env bash
set -euo pipefail

# /init expands CLAMD_CONF_* before it execs this supervisor. Refuse to start
# if the effective daemon config drifted, otherwise the worker could advertise
# a 100 MiB boundary while clamd silently kept its smaller INSTREAM default.
for setting in StreamMaxLength MaxFileSize MaxScanSize; do
  if ! grep -Eq "^${setting}[[:space:]]+100M[[:space:]]*$" /etc/clamav/clamd.conf; then
    echo "ClamAV daemon config must set ${setting}=100M" >&2
    exit 1
  fi
done
if ! grep -Eq '^AlertExceedsMax[[:space:]]+yes[[:space:]]*$' /etc/clamav/clamd.conf; then
  echo 'ClamAV daemon config must set AlertExceedsMax=yes' >&2
  exit 1
fi

# The upstream image backgrounds clamd and then waits on `tail -f /dev/null`,
# so a clamd OOM leaves the container running but unable to scan. Keep both
# daemons under one PID 1 and exit when either child dies; Compose can then
# apply restart:unless-stopped without weakening scanner readiness.
freshclam \
  --checks="${FRESHCLAM_CHECKS:-24}" \
  --daemon \
  --foreground \
  --stdout \
  --user=clamav &
freshclam_pid=$!
# Under `set -e` a die-and-vanish child would otherwise leave PID 1 waiting on
# a zombie while Compose still reports the container as healthy.
kill -0 "$freshclam_pid" || exit 1

clamd --foreground &
clamd_pid=$!
kill -0 "$clamd_pid" || exit 1

shutdown_children() {
  trap - TERM INT
  kill -TERM "$freshclam_pid" "$clamd_pid" 2>/dev/null || true
  wait "$freshclam_pid" "$clamd_pid" 2>/dev/null || true
}

trap 'shutdown_children; exit 0' TERM INT

# `wait -n` reports the first child's status. Capture it without letting
# `set -e` abort before the sibling daemon is shut down.
status=0
wait -n "$freshclam_pid" "$clamd_pid" || status=$?
shutdown_children

# A daemon exiting cleanly is still unexpected for this long-running service.
# Spelled as an explicit `if`: a bare `[ ... ] && ...` as the final command
# would exit non-zero under `set -e` before the intended status is applied.
if [ "$status" -eq 0 ]; then
  status=1
fi
exit "$status"
