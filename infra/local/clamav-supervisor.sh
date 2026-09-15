#!/usr/bin/env bash
set -uo pipefail

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

clamd --foreground &
clamd_pid=$!

shutdown_children() {
  trap - TERM INT
  kill -TERM "$freshclam_pid" "$clamd_pid" 2>/dev/null || true
  wait "$freshclam_pid" "$clamd_pid" 2>/dev/null || true
}

trap 'shutdown_children; exit 0' TERM INT

wait -n "$freshclam_pid" "$clamd_pid"
status=$?
shutdown_children

# A daemon exiting cleanly is still unexpected for this long-running service.
[ "$status" -eq 0 ] && status=1
exit "$status"
