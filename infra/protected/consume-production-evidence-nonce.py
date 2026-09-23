#!/usr/bin/env python3
"""Root-owned ECS release nonce consumer; install outside the mutable repository.

The deployment wrapper pins this executable's SHA-256 in the root-owned trust
bundle. The ledger is durable across deployments and container restarts.
"""

import argparse
import os
import re
import sqlite3
import stat
import sys

LEDGER_DIRECTORY = '/var/lib/merchant-release-security'
LEDGER_PATH = LEDGER_DIRECTORY + '/production-nonces.sqlite3'


def secure_directory(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('nonce ledger directory must be a root-owned 0700 directory')


def secure_parent(path):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError('nonce ledger parent must be root-owned, non-symlink and non-writable by group or others')


def secure_ledger(path):
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError('nonce ledger must be a root-owned regular 0600 file')
    return info


def verify_opened_ledger(connection, path, before):
    """Reject path replacement and insecure creation before writing a nonce."""
    secure_parent('/var')
    secure_parent('/var/lib')
    secure_directory(os.path.dirname(path))
    after = secure_ledger(path)
    if after is None:
        raise RuntimeError('nonce ledger disappeared after opening')
    if before is not None and (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise RuntimeError('nonce ledger changed while opening')
    databases = connection.execute('PRAGMA database_list').fetchall()
    if len(databases) != 1 or databases[0][1] != 'main' or os.path.realpath(databases[0][2]) != os.path.realpath(path):
        raise RuntimeError('nonce ledger opened at an unexpected path')


def consume(ledger_path, namespace, nonce, release_id, image_digest, manifest_sha256,
            release_git_sha, operation='deployment', attempt_id=''):
    """Atomically consume a nonce and bind it to exactly one operation/attempt."""
    if os.geteuid() != 0:
        raise RuntimeError('nonce consumer must run as root')
    if operation not in ('deployment', 'bridge-b'):
        raise RuntimeError('operation must be deployment or bridge-b')
    if operation == 'deployment' and attempt_id:
        raise RuntimeError('deployment operation must not include an attempt ID')
    if operation == 'bridge-b' and not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', attempt_id):
        raise RuntimeError('bridge-b operation requires a valid attempt ID')
    secure_parent('/var')
    secure_parent('/var/lib')
    secure_directory(os.path.dirname(ledger_path))
    before = secure_ledger(ledger_path)
    old_umask = os.umask(0o077)
    try:
        connection = sqlite3.connect(ledger_path, timeout=30, isolation_level=None)
    finally:
        os.umask(old_umask)
    try:
        verify_opened_ledger(connection, ledger_path, before)
        connection.execute('PRAGMA journal_mode=DELETE')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('''CREATE TABLE IF NOT EXISTS consumed_nonces (
            namespace TEXT NOT NULL, nonce TEXT NOT NULL, release_id TEXT NOT NULL,
            image_digest TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
            release_git_sha TEXT NOT NULL, consumed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (namespace, nonce)
        )''')
        # Keep operation ownership separate from the historical consumption
        # table. Existing rows intentionally have no owner and cannot be
        # adopted by Bridge B based only on a matching release identity.
        connection.execute('''CREATE TABLE IF NOT EXISTS nonce_owners (
            namespace TEXT NOT NULL, nonce TEXT NOT NULL,
            operation TEXT NOT NULL, attempt_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (namespace, nonce)
        )''')
        connection.execute('''INSERT INTO consumed_nonces
            (namespace, nonce, release_id, image_digest, manifest_sha256, release_git_sha)
            VALUES (?, ?, ?, ?, ?, ?)''',
            (namespace, nonce, release_id, image_digest, manifest_sha256, release_git_sha))
        connection.execute('''INSERT INTO nonce_owners
            (namespace, nonce, operation, attempt_id) VALUES (?, ?, ?, ?)''',
            (namespace, nonce, operation, attempt_id))
        connection.execute('COMMIT')
    except Exception:
        if connection.in_transaction:
            connection.execute('ROLLBACK')
        raise
    finally:
        connection.close()


def parse_args(argv):
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest='command')
    command = subcommands.add_parser('consume')
    for name in ('namespace', 'nonce', 'release-id', 'image-digest', 'manifest-sha256', 'release-git-sha'):
        command.add_argument('--' + name, required=True)
    command.add_argument('--operation', choices=('deployment', 'bridge-b'))
    command.add_argument('--attempt-id')
    args = parser.parse_args(argv)
    if args.command != 'consume':
        parser.error('consume subcommand is required')
    return args


def main(argv):
    args = parse_args(argv)
    if args.namespace != 'merchant-production-deploy':
        raise RuntimeError('unexpected production nonce namespace')
    if not re.fullmatch(r'[A-Za-z0-9_-]{22,128}', args.nonce):
        raise RuntimeError('nonce must be 22-128 URL-safe characters')
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', args.release_id):
        raise RuntimeError('release ID is invalid')
    if not re.fullmatch(r'sha256:[0-9a-fA-F]{64}', args.image_digest):
        raise RuntimeError('image digest is invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', args.manifest_sha256):
        raise RuntimeError('manifest SHA-256 is invalid')
    if not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', args.release_git_sha):
        raise RuntimeError('Git SHA is invalid')
    operation = args.operation or 'deployment'
    attempt_id = args.attempt_id or ''
    if args.operation is None and args.attempt_id is not None:
        raise RuntimeError('--attempt-id requires --operation bridge-b')
    consume(LEDGER_PATH, args.namespace, args.nonce, args.release_id,
            args.image_digest, args.manifest_sha256, args.release_git_sha,
            operation, attempt_id)
    print('nonce accepted')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (RuntimeError, sqlite3.Error, OSError) as error:
        print('nonce rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
