#!/bin/sh

# Shared host build lock. Source this file and call ecs_build_lock_acquire after
# cheap input validation but before npm/Docker work. Linux uses an FD lock when
# flock exists; portable hosts use an atomic mkdir fallback.

ecs_build_lock_acquire() {
  ECS_BUILD_LOCK_HELD=NO
  lock_path=${ECS_BUILD_LOCK_PATH:-/var/lib/merchant-release-security/locks/ecs-source-build.lock}
  # Parent traversal and pre-existing lock checks run without shell evaluation.
  ECS_BUILD_LOCK_VALIDATE_PATH="$lock_path" node <<'NODE'
const fs = require('node:fs'), path = require('node:path')
const target = process.env.ECS_BUILD_LOCK_VALIDATE_PATH
const fail = message => { console.error(message); process.exit(2) }
if (!path.isAbsolute(target) || path.resolve(target) !== target) fail('ECS_BUILD_LOCK_PATH must be absolute and canonical')
const parent = path.dirname(target)
if (fs.realpathSync(parent) !== parent) fail('ECS_BUILD_LOCK_PATH parent must be canonical')
let cursor = parent
for (;;) {
  const stat = fs.lstatSync(cursor)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== process.getuid() && stat.uid !== 0)) fail('unsafe build lock ancestor')
  if ((stat.mode & 0o022) && !(cursor !== parent && (stat.mode & 0o1000))) fail('build lock parent must not be group/world writable')
  if (cursor === parent && stat.uid !== process.getuid()) fail('build lock parent must be owned by build user')
  if (cursor === path.dirname(cursor)) break
  cursor = path.dirname(cursor)
}
try {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) fail('ECS_BUILD_LOCK_PATH must not be a symlink')
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('build lock must be private and owned by build user')
} catch (error) { if (error.code !== 'ENOENT') throw error }
NODE
  lock_validation=$?
  [ "$lock_validation" = 0 ] || return "$lock_validation"
  case "$lock_path" in /*) ;; *) echo 'ECS_BUILD_LOCK_PATH must be absolute' >&2; return 2 ;; esac
  lock_parent=${lock_path%/*}
  [ -n "$lock_parent" ] || lock_parent=/
  [ -d "$lock_parent" ] && [ ! -L "$lock_parent" ] || { echo 'ECS_BUILD_LOCK_PATH parent must be a real directory' >&2; return 2; }
  [ ! -L "$lock_path" ] || { echo 'ECS_BUILD_LOCK_PATH must not be a symlink' >&2; return 2; }
  lock_owner=$(if stat -c '%u' "$lock_parent" >/dev/null 2>&1; then stat -c '%u' "$lock_parent"; else stat -f '%u' "$lock_parent"; fi)
  [ "$lock_owner" = "$(id -u)" ] || { echo 'ECS_BUILD_LOCK_PATH parent must be owned by the build user' >&2; return 2; }
  lock_mode=$(if stat -c '%a' "$lock_parent" >/dev/null 2>&1; then stat -c '%a' "$lock_parent"; else stat -f '%Lp' "$lock_parent"; fi)
  case "$lock_mode" in *[2367][0-7]|*[2367]) echo 'ECS_BUILD_LOCK_PATH parent must not be group/world writable' >&2; return 2 ;; esac

  ecs_build_lock_cleanup() {
    if [ "${ECS_BUILD_LOCK_BACKEND:-}" = mkdir ] && [ "${ECS_BUILD_LOCK_HELD:-NO}" = YES ]; then
      rmdir "$lock_path" 2>/dev/null || true
    elif [ "${ECS_BUILD_LOCK_BACKEND:-}" = flock ] && [ "${ECS_BUILD_LOCK_HELD:-NO}" = YES ]; then
      exec 7>&-
    fi
    ECS_BUILD_LOCK_HELD=NO
  }
  trap ecs_build_lock_cleanup EXIT

  if command -v flock >/dev/null 2>&1; then
    [ ! -e "$lock_path" ] || [ -f "$lock_path" ] || { echo 'ECS_BUILD_LOCK_PATH must be a regular file' >&2; return 2; }
    if [ ! -e "$lock_path" ]; then
      (umask 077; set -C; : > "$lock_path") 2>/dev/null || true
    fi
    exec 7>>"$lock_path"
    if ! flock -n 7; then
      echo "another ECS source build is in progress: $lock_path" >&2
      exec 7>&-
      return 1
    fi
    ECS_BUILD_LOCK_BACKEND=flock ECS_BUILD_LOCK_HELD=YES
  else
    if ! mkdir -m 0700 "$lock_path" 2>/dev/null; then
      echo "another ECS source build is in progress: $lock_path" >&2
      return 1
    fi
    ECS_BUILD_LOCK_BACKEND=mkdir ECS_BUILD_LOCK_HELD=YES
  fi
}
