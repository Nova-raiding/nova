"""Run as root on an isolated ECS candidate; never points at the production ledger."""

import concurrent.futures
import os
from pathlib import Path
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
        print('isolated nonce candidate: same nonce 1/24 accepted, 23/24 rejected; unique nonces 24/24 accepted; replay, changed binding, invalid nonce, insecure directory/file mode, wrong owner, symlink and corrupt ledger rejected')


if __name__ == '__main__':
    main()
