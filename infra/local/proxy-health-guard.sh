#!/bin/sh

set -eu

# This guard intentionally owns no proxy configuration. It verifies the active
# v2rayN/xray data path and only performs recovery when an operator explicitly
# opts in to one of the bounded recovery interfaces below.

HTTP_HOST=${PROXY_GUARD_HTTP_HOST:-127.0.0.1}
HTTP_PORT=${PROXY_GUARD_HTTP_PORT:-10808}
SOCKS_HOST=${PROXY_GUARD_SOCKS_HOST:-127.0.0.1}
# v2rayN commonly exposes one mixed inbound. Override with 10809 when a
# dedicated SOCKS inbound is configured.
SOCKS_PORT=${PROXY_GUARD_SOCKS_PORT:-$HTTP_PORT}
HEALTH_URL=${PROXY_GUARD_HEALTH_URL:-https://example.com/}
EXPECTED_STATUS=${PROXY_GUARD_EXPECTED_STATUS:-200}
CONNECT_TIMEOUT=${PROXY_GUARD_CONNECT_TIMEOUT:-4}
REQUEST_TIMEOUT=${PROXY_GUARD_REQUEST_TIMEOUT:-10}
FD_THRESHOLD=${PROXY_GUARD_FD_THRESHOLD:-220}
FAILURE_THRESHOLD=${PROXY_GUARD_FAILURE_THRESHOLD:-3}
COOLDOWN_SECONDS=${PROXY_GUARD_COOLDOWN_SECONDS:-300}
SETTLE_SECONDS=${PROXY_GUARD_SETTLE_SECONDS:-8}
STATE_DIR=${PROXY_GUARD_STATE_DIR:-"${TMPDIR:-/tmp}/merchant-proxy-health-${UID:-$(id -u)}"}
START_V2RAYN=${PROXY_GUARD_START_V2RAYN:-0}
V2RAYN_APP=${PROXY_GUARD_V2RAYN_APP:-/Applications/v2rayN.app}
RESTART_COMMAND=${PROXY_GUARD_RESTART_COMMAND:-}

CURL_BIN=${PROXY_GUARD_CURL_BIN:-/usr/bin/curl}
LSOF_BIN=${PROXY_GUARD_LSOF_BIN:-/usr/sbin/lsof}
PS_BIN=${PROXY_GUARD_PS_BIN:-/bin/ps}
DATE_BIN=${PROXY_GUARD_DATE_BIN:-/bin/date}
OPEN_BIN=${PROXY_GUARD_OPEN_BIN:-/usr/bin/open}
ENV_BIN=${PROXY_GUARD_ENV_BIN:-/usr/bin/env}
SLEEP_BIN=${PROXY_GUARD_SLEEP_BIN:-/bin/sleep}

LOCK_DIR=$STATE_DIR/lock
FAILURE_FILE=$STATE_DIR/failure-count
LAST_RECOVERY_FILE=$STATE_DIR/last-recovery

log_event() {
  # Keep logs deliberately low-cardinality. Never print the health URL,
  # environment, node address, command, or curl error body.
  printf '%s proxy_guard %s\n' "$("$DATE_BIN" -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

is_uint() {
  case ${1:-} in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

require_uint() {
  value=$1
  name=$2
  if ! is_uint "$value"; then
    log_event "event=invalid_configuration field=$name"
    exit 2
  fi
}

for executable in "$CURL_BIN" "$LSOF_BIN" "$PS_BIN" "$DATE_BIN" "$ENV_BIN" "$SLEEP_BIN"; do
  if [ ! -x "$executable" ]; then
    log_event "event=missing_dependency"
    exit 2
  fi
done

require_uint "$HTTP_PORT" http_port
require_uint "$SOCKS_PORT" socks_port
require_uint "$EXPECTED_STATUS" expected_status
require_uint "$CONNECT_TIMEOUT" connect_timeout
require_uint "$REQUEST_TIMEOUT" request_timeout
require_uint "$FD_THRESHOLD" fd_threshold
require_uint "$FAILURE_THRESHOLD" failure_threshold
require_uint "$COOLDOWN_SECONDS" cooldown_seconds
require_uint "$SETTLE_SECONDS" settle_seconds

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

release_lock() {
  if [ -d "$LOCK_DIR" ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    trap release_lock EXIT HUP INT TERM
    return 0
  fi

  lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if is_uint "$lock_pid" && kill -0 "$lock_pid" 2>/dev/null; then
    log_event "event=already_running"
    exit 0
  fi

  # Recover only this guard's stale, single-file lock directory.
  rm -f "$LOCK_DIR/pid"
  if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log_event "event=lock_unavailable"
    exit 2
  fi
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  trap release_lock EXIT HUP INT TERM
}

acquire_lock

listener_pid() {
  "$LSOF_BIN" -nP -iTCP@"$HTTP_HOST":"$HTTP_PORT" -sTCP:LISTEN -t 2>/dev/null \
    | awk 'NR == 1 { print; exit }'
}

is_xray_pid() {
  candidate_pid=$1
  is_uint "$candidate_pid" || return 1
  command_name=$("$PS_BIN" -p "$candidate_pid" -o comm= 2>/dev/null | awk 'NR == 1 { print; exit }')
  [ "${command_name##*/}" = xray ]
}

fd_count() {
  target_pid=$1
  "$LSOF_BIN" -p "$target_pid" -Ff 2>/dev/null \
    | awk 'substr($0, 1, 1) == "f" && substr($0, 2) ~ /^[0-9]+$/ { seen[substr($0, 2)] = 1 } END { for (fd in seen) count += 1; print count + 0 }'
}

probe_http() {
  status=$("$CURL_BIN" -sS -o /dev/null \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" \
    --proxy "http://$HTTP_HOST:$HTTP_PORT" --write-out '%{http_code}' \
    "$HEALTH_URL" 2>/dev/null || true)
  [ "$status" = "$EXPECTED_STATUS" ]
}

probe_socks() {
  status=$("$CURL_BIN" -sS -o /dev/null \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$REQUEST_TIMEOUT" \
    --proxy "socks5h://$SOCKS_HOST:$SOCKS_PORT" --write-out '%{http_code}' \
    "$HEALTH_URL" 2>/dev/null || true)
  [ "$status" = "$EXPECTED_STATUS" ]
}

read_counter() {
  counter=$(cat "$1" 2>/dev/null || true)
  if is_uint "$counter"; then
    printf '%s\n' "$counter"
  else
    printf '0\n'
  fi
}

write_counter() {
  printf '%s\n' "$2" > "$1"
}

sanitized_environment() {
  safe_home=${HOME:-/Users/Shared}
  safe_user=${USER:-$(id -un)}
  safe_logname=${LOGNAME:-$safe_user}
  safe_tmp=${TMPDIR:-/tmp}
  "$ENV_BIN" -i \
    HOME="$safe_home" USER="$safe_user" LOGNAME="$safe_logname" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$safe_tmp" \
    "$@"
}

cooldown_remaining() {
  now=$("$DATE_BIN" '+%s')
  previous=$(read_counter "$LAST_RECOVERY_FILE")
  elapsed=$((now - previous))
  if [ "$elapsed" -lt "$COOLDOWN_SECONDS" ]; then
    printf '%s\n' "$((COOLDOWN_SECONDS - elapsed))"
  else
    printf '0\n'
  fi
}

record_recovery() {
  "$DATE_BIN" '+%s' > "$LAST_RECOVERY_FILE"
}

perform_recovery() {
  reason=$1
  remaining=$(cooldown_remaining)
  if [ "$remaining" -gt 0 ]; then
    log_event "event=recovery_cooldown reason=$reason remaining_seconds=$remaining"
    return 1
  fi

  if [ -n "$RESTART_COMMAND" ]; then
    record_recovery
    log_event "event=recovery_started reason=$reason method=operator_command"
    if ! sanitized_environment /bin/sh -c "$RESTART_COMMAND" >/dev/null 2>&1; then
      log_event "event=recovery_command_failed reason=$reason"
      return 1
    fi
  elif [ "$reason" = dead ] && [ "$START_V2RAYN" = 1 ]; then
    if [ ! -x "$OPEN_BIN" ] || [ ! -d "$V2RAYN_APP" ]; then
      log_event "event=recovery_unavailable reason=$reason"
      return 1
    fi
    record_recovery
    log_event "event=recovery_started reason=$reason method=sanitized_v2rayn_start"
    if ! sanitized_environment "$OPEN_BIN" -gj "$V2RAYN_APP" >/dev/null 2>&1; then
      log_event "event=recovery_command_failed reason=$reason"
      return 1
    fi
  else
    log_event "event=unhealthy_fail_closed reason=$reason recovery=not_configured"
    return 1
  fi

  "$SLEEP_BIN" "$SETTLE_SECONDS"
  return 0
}

classify_health() {
  XRAY_PID=$(listener_pid)
  if ! is_xray_pid "$XRAY_PID"; then
    HEALTH_REASON=dead
    XRAY_FDS=0
    return 1
  fi

  XRAY_FDS=$(fd_count "$XRAY_PID")
  if ! is_uint "$XRAY_FDS"; then
    XRAY_FDS=0
  fi

  http_ok=0
  socks_ok=0
  probe_http && http_ok=1
  probe_socks && socks_ok=1

  if [ "$XRAY_FDS" -ge "$FD_THRESHOLD" ]; then
    HEALTH_REASON=high_fd
    return 1
  fi
  if [ "$http_ok" -ne 1 ] || [ "$socks_ok" -ne 1 ]; then
    HEALTH_REASON=stale
    return 1
  fi

  HEALTH_REASON=healthy
  return 0
}

if classify_health; then
  write_counter "$FAILURE_FILE" 0
  log_event "event=healthy pid=$XRAY_PID fd_count=$XRAY_FDS protocols=http,socks"
  exit 0
fi

failures=$(read_counter "$FAILURE_FILE")
failures=$((failures + 1))
write_counter "$FAILURE_FILE" "$failures"
log_event "event=unhealthy reason=$HEALTH_REASON pid=${XRAY_PID:-none} fd_count=${XRAY_FDS:-0} consecutive_failures=$failures"

# A dead process and FD exhaustion are deterministic. A functional probe may
# fail transiently, so stale forwarding requires repeated failures.
if [ "$HEALTH_REASON" = stale ] && [ "$failures" -lt "$FAILURE_THRESHOLD" ]; then
  exit 1
fi

if ! perform_recovery "$HEALTH_REASON"; then
  exit 1
fi

if classify_health; then
  write_counter "$FAILURE_FILE" 0
  log_event "event=recovered pid=$XRAY_PID fd_count=$XRAY_FDS protocols=http,socks"
  exit 0
fi

log_event "event=recovery_verification_failed reason=$HEALTH_REASON pid=${XRAY_PID:-none} fd_count=${XRAY_FDS:-0}"
exit 1
