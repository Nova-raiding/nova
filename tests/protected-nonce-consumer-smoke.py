"""Run as root on an isolated ECS candidate; never points at the production ledger."""

import concurrent.futures
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile


def main():
    if os.geteuid() != 0:
        raise RuntimeError('isolated nonce smoke requires root')
    source = Path(sys.argv[1]).read_text()
    with tempfile.TemporaryDirectory(prefix='merchant-nonce-candidate-') as root:
        ledger_dir = Path(root) / 'ledger'
        ledger_dir.mkdir(mode=0o700)
        script = Path(root) / 'consumer.py'
        assert source.count("LEDGER_DIRECTORY = '/var/lib/merchant-release-security'") == 1
        script.write_text(source.replace("LEDGER_DIRECTORY = '/var/lib/merchant-release-security'",
                                         'LEDGER_DIRECTORY = ' + repr(str(ledger_dir))))
        args = [sys.executable, str(script), 'consume', '--namespace', 'merchant-production-deploy',
                '--nonce', 'A' * 24, '--release-id', 'candidate-nonce-test',
                '--image-digest', 'sha256:' + 'a' * 64,
                '--manifest-sha256', 'b' * 64, '--release-git-sha', 'c' * 40]
        def run(_):
            return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  universal_newlines=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(run, range(24)))
        accepted = [result for result in results if result.returncode == 0]
        rejected = [result for result in results if result.returncode != 0]
        assert len(accepted) == 1 and len(rejected) == 23, (len(accepted), len(rejected))
        assert all('nonce rejected' in item.stderr for item in rejected)
        accepted_nonce = args[args.index('--nonce') + 1]
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            owner = ledger.execute('SELECT operation, attempt_id FROM nonce_owners WHERE namespace=? AND nonce=?',
                                   ('merchant-production-deploy', accepted_nonce)).fetchone()
        assert owner == ('deployment', ''), owner
        bridge_reuse = list(args) + ['--operation', 'bridge-b', '--attempt-id', 'attempt_BridgeB_abcdefghijkl']
        reused = subprocess.run(bridge_reuse, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True)
        assert reused.returncode != 0 and 'nonce rejected' in reused.stderr
        fresh_bridge = list(args)
        fresh_bridge[fresh_bridge.index('--nonce') + 1] = 'C' * 24
        fresh_bridge += ['--operation', 'bridge-b', '--attempt-id', 'attempt_BridgeB_abcdefghijkl']
        bridge_result = subprocess.run(fresh_bridge, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       universal_newlines=True)
        assert bridge_result.returncode == 0, bridge_result.stderr
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            bridge_owner = ledger.execute('SELECT operation, attempt_id FROM nonce_owners WHERE namespace=? AND nonce=?',
                                          ('merchant-production-deploy', 'C' * 24)).fetchone()
        assert bridge_owner == ('bridge-b', 'attempt_BridgeB_abcdefghijkl'), bridge_owner
        bridge_same_attempt_replay = subprocess.run(fresh_bridge, stdout=subprocess.PIPE,
                                                    stderr=subprocess.PIPE, universal_newlines=True)
        assert bridge_same_attempt_replay.returncode != 0, 'consumer must remain strictly one-shot even for same-attempt retry'
        bridge_other_attempt = list(fresh_bridge)
        bridge_other_attempt[bridge_other_attempt.index('--attempt-id') + 1] = 'attempt_BridgeB_other_abcdefgh'
        other_attempt_replay = subprocess.run(bridge_other_attempt, stdout=subprocess.PIPE,
                                              stderr=subprocess.PIPE, universal_newlines=True)
        assert other_attempt_replay.returncode != 0
        fresh_254 = list(args)
        fresh_254[fresh_254.index('--nonce') + 1] = 'E' * 24
        fresh_254 += ['--operation', 'bridge-254', '--attempt-id', 'attempt_Bridge254_abcdefgh']
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            bridge_254_results = list(pool.map(
                lambda _: subprocess.run(fresh_254, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         universal_newlines=True), range(24)))
        assert sum(item.returncode == 0 for item in bridge_254_results) == 1, [item.stderr for item in bridge_254_results]
        assert all('nonce rejected' in item.stderr for item in bridge_254_results if item.returncode != 0)
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            bound = ledger.execute('''SELECT consumed_nonces.release_id, nonce_owners.operation,
                nonce_owners.attempt_id FROM consumed_nonces JOIN nonce_owners USING(namespace, nonce)
                WHERE namespace=? AND nonce=?''', ('merchant-production-deploy', 'E' * 24)).fetchall()
            assert bound == [('candidate-nonce-test', 'bridge-254', 'attempt_Bridge254_abcdefgh')], bound
            assert ledger.execute('SELECT COUNT(*) FROM consumed_nonces WHERE nonce=?', ('E' * 24,)).fetchone()[0] == 1
            assert ledger.execute('SELECT COUNT(*) FROM nonce_owners WHERE nonce=?', ('E' * 24,)).fetchone()[0] == 1
        fresh_backup = list(args)
        fresh_backup[fresh_backup.index('--nonce') + 1] = 'G' * 24
        fresh_backup += ['--operation', 'demo-254-backup', '--attempt-id', 'attempt_Demo254_abcdefgh']
        backup_result = subprocess.run(fresh_backup, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       universal_newlines=True)
        assert backup_result.returncode == 0, backup_result.stderr
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            backup_owner = ledger.execute('SELECT operation,attempt_id FROM nonce_owners WHERE namespace=? AND nonce=?',
                                          ('merchant-production-deploy', 'G' * 24)).fetchone()
        assert backup_owner == ('demo-254-backup', 'attempt_Demo254_abcdefgh'), backup_owner
        assert subprocess.run(fresh_backup, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True).returncode != 0
        for operation in ('deployment', 'bridge-b', 'bridge-254', 'demo-254-backup'):
            cross = list(args)
            cross[cross.index('--nonce') + 1] = 'E' * 24
            if operation != 'deployment':
                cross += ['--operation', operation, '--attempt-id', 'attempt_Other_abcdefghijkl']
            result = subprocess.run(cross, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    universal_newlines=True)
            assert result.returncode != 0, 'consumed bridge-254 nonce must reject replay or cross-operation takeover'
        bridge_254_on_b = list(fresh_254)
        bridge_254_on_b[bridge_254_on_b.index('--nonce') + 1] = 'C' * 24
        assert subprocess.run(bridge_254_on_b, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True).returncode != 0
        bridge_254_on_deployment = list(fresh_254)
        bridge_254_on_deployment[bridge_254_on_deployment.index('--nonce') + 1] = 'A' * 24
        assert subprocess.run(bridge_254_on_deployment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True).returncode != 0
        no_attempt = fresh_254[:-2]
        assert subprocess.run(no_attempt, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True).returncode != 0
        invalid_attempt = list(fresh_254)
        invalid_attempt[invalid_attempt.index('--attempt-id') + 1] = 'short'
        assert subprocess.run(invalid_attempt, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True).returncode != 0
        competing_254 = list(fresh_254)
        competing_254[competing_254.index('--nonce') + 1] = 'F' * 24
        competing_b = list(fresh_bridge)
        competing_b[competing_b.index('--nonce') + 1] = 'F' * 24
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            contenders = list(pool.map(lambda command: subprocess.run(
                command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True),
                (competing_254, competing_b)))
        assert sum(item.returncode == 0 for item in contenders) == 1, [item.stderr for item in contenders]
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            records = ledger.execute('''SELECT consumed_nonces.release_id, nonce_owners.operation,
                nonce_owners.attempt_id FROM consumed_nonces JOIN nonce_owners USING(namespace, nonce)
                WHERE namespace=? AND nonce=?''', ('merchant-production-deploy', 'F' * 24)).fetchall()
            assert len(records) == 1 and records[0][1:] in (
                ('bridge-254', 'attempt_Bridge254_abcdefgh'),
                ('bridge-b', 'attempt_BridgeB_abcdefghijkl')), records
            assert ledger.execute('SELECT COUNT(*) FROM consumed_nonces WHERE nonce=?', ('F' * 24,)).fetchone()[0] == 1
            assert ledger.execute('SELECT COUNT(*) FROM nonce_owners WHERE nonce=?', ('F' * 24,)).fetchone()[0] == 1
        # A legacy consumed row without a nonce_owners row cannot be adopted by B.
        legacy_nonce = 'D' * 24
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            ledger.execute('INSERT INTO consumed_nonces(namespace,nonce,release_id,image_digest,manifest_sha256,release_git_sha) VALUES(?,?,?,?,?,?)',
                           ('merchant-production-deploy', legacy_nonce, 'candidate-nonce-test',
                            'sha256:' + 'a' * 64, 'b' * 64, 'c' * 40))
        legacy_bridge = list(args)
        legacy_bridge[legacy_bridge.index('--nonce') + 1] = legacy_nonce
        legacy_bridge += ['--operation', 'bridge-b', '--attempt-id', 'attempt_BridgeB_legacy_abcdefgh']
        legacy_adoption = subprocess.run(legacy_bridge, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, universal_newlines=True)
        assert legacy_adoption.returncode != 0
        with sqlite3.connect(str(ledger_dir / 'production-nonces.sqlite3')) as ledger:
            assert ledger.execute('SELECT 1 FROM nonce_owners WHERE namespace=? AND nonce=?',
                                  ('merchant-production-deploy', legacy_nonce)).fetchone() is None
        replay = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True)
        assert replay.returncode != 0
        changed_binding = subprocess.run(args[:-1] + ['d' * 40], stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, universal_newlines=True)
        assert changed_binding.returncode != 0
        assert (ledger_dir / 'production-nonces.sqlite3').stat().st_mode & 0o777 == 0o600
        invalid = subprocess.run(args[:args.index('--nonce') + 1] + ['short'] +
                                 args[args.index('--nonce') + 2:], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, universal_newlines=True)
        assert invalid.returncode != 0
        ledger_dir.chmod(0o777)
        insecure_directory = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             universal_newlines=True)
        assert insecure_directory.returncode != 0 and '0700 directory' in insecure_directory.stderr
        ledger_dir.chmod(0o700)
        def unique_run(index):
            unique_args = list(args)
            unique_args[unique_args.index('--nonce') + 1] = 'B' * 22 + '%02d' % index
            return subprocess.run(unique_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  universal_newlines=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            unique_results = list(pool.map(unique_run, range(24)))
        assert all(item.returncode == 0 for item in unique_results), [item.stderr for item in unique_results if item.returncode]
        ledger = ledger_dir / 'production-nonces.sqlite3'
        ledger.chmod(0o666)
        assert unique_run(25).returncode != 0
        ledger.chmod(0o600)
        os.chown(ledger, 65534, 65534)
        assert unique_run(28).returncode != 0
        os.chown(ledger, 0, 0)
        ledger.rename(ledger_dir / 'saved-ledger.sqlite3')
        ledger.symlink_to(ledger_dir / 'saved-ledger.sqlite3')
        assert unique_run(26).returncode != 0
        ledger.unlink()
        (ledger_dir / 'saved-ledger.sqlite3').rename(ledger)
        ledger.write_bytes(b'corrupt sqlite bytes')
        assert unique_run(27).returncode != 0
        print('isolated nonce candidate: deployment, bridge-b, bridge-254 and demo-254-backup owners atomically recorded; bridge-254 same-attempt 24-way race has one winner; replay, cross-operation takeover, invalid attempt, legacy-row adoption, insecure ledger and corrupt ledger rejected')


if __name__ == '__main__':
    main()
