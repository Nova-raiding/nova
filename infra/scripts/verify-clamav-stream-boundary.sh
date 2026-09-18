#!/usr/bin/env sh
set -eu

# Isolated runtime acceptance for the daemon transport boundary only. This
# never mounts business data, restarts shared services, or claims API/worker
# end-to-end or cloud acceptance.
case "${1:-compose}" in
  compose)
    image='clamav/clamav-debian@sha256:bcfc3d6117a6cfbeb6cd041c00164097916291b870c6183e06def6fed7fb740b'
    set --
    ;;
  kubernetes)
    image='clamav/clamav@sha256:761f6c99b8d9134b39431f8c200189cda749b17310091561bfa8b732f32bfada'
    set -- --platform linux/amd64
    ;;
  *) echo 'usage: verify-clamav-stream-boundary.sh [compose|kubernetes]' >&2; exit 2 ;;
esac

run_name="merchant-clamav-boundary-$(date +%s)-$$"
printf 'scope=isolated_clamd_instream cloud_gate=false image=%s container=%s\n' "$image" "$run_name"
docker run --rm --name "$run_name" --memory 2g --cpus 1.5 "$@" \
  -e CLAMD_CONF_StreamMaxLength=100M \
  -e CLAMD_CONF_MaxFileSize=100M \
  -e CLAMD_CONF_MaxScanSize=100M \
  -e CLAMD_CONF_AlertExceedsMax=yes \
  "$image" sh -c '
    set -eu
    for setting in StreamMaxLength MaxFileSize MaxScanSize; do
      grep -E "^${setting}[[:space:]]+100M$" /etc/clamav/clamd.conf
    done
    grep -E "^AlertExceedsMax[[:space:]]+yes$" /etc/clamav/clamd.conf
    clamd --foreground >/tmp/clamd-boundary.log 2>&1 &
    daemon_pid=$!
    trap '\''kill "$daemon_pid" 2>/dev/null || true'\'' EXIT INT TERM
    for attempt in $(seq 1 90); do
      if clamdscan --ping 1 >/dev/null 2>&1; then break; fi
      sleep 1
    done
    clamdscan --ping 1
    dd if=/dev/zero of=/tmp/scan-100m.bin bs=1048576 count=100 2>/dev/null
    test "$(wc -c </tmp/scan-100m.bin)" -eq 104857600
    wc -c /tmp/scan-100m.bin
    clamdscan --stream /tmp/scan-100m.bin
    # A small compressed object expanding past the limit must be FOUND, not
    # silently OK. The contents are only generated zeroes, not real malware.
    dd if=/dev/zero bs=1048576 count=101 2>/dev/null | gzip -c >/tmp/scan-expanded.gz
    set +e
    expanded_result=$(clamdscan --stream /tmp/scan-expanded.gz 2>&1)
    expanded_status=$?
    set -e
    printf "%s\n" "$expanded_result"
    test "$expanded_status" -eq 1
    printf "%s\n" "$expanded_result" | grep -E "Heuristics.Limits.Exceeded.* FOUND"
    kill "$daemon_pid"
    wait "$daemon_pid" || true
    trap - EXIT INT TERM
  '

remaining=$(docker ps -a --filter "name=^/${run_name}$" --format '{{.ID}}')
test -z "$remaining" || { echo 'isolated ClamAV container was not auto-removed' >&2; exit 1; }
printf 'status=pass boundary_bytes=104857600 expanded_limit=blocked container_auto_removed=true shared_containers_touched=false\n'
