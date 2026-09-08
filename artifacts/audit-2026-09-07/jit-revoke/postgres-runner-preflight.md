# Authorization PostgreSQL isolation runner preflight

- Scope: exactly six PostgreSQL files / eight tests; no source edits.
- Owner reviewed the artifact runner and authorized one isolated run after import/root path correction.
- Pure self-test: valid report accepted; eight malformed reports rejected; clean system environments accepted; ten unsafe environment cases rejected. No Docker or SQL executed by self-test.
- Strict standalone TypeScript check passed (`--noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --noUncheckedIndexedAccess`).
- Initial system `node` resolution under a minimal PATH was an unusable Homebrew Node 20 binary (missing ICU dylib). No task code, Docker, or SQL ran. Subsequent commands use the existing Node 22 absolute executable; no machine configuration was changed.
- First actual launcher attempt exited 1 before creating any evidence run directory or container because macOS injected `__CF_USER_TEXT_ENCODING` after `env -i`. The parent environment gate rejected this unknown key. No Docker, SQL, or cleanup ran.
- Owner approved recognizing only that macOS system encoding tuple; its value is not logged, and it is not forwarded by the Vitest environment whitelist. An actual `env -i` parent environment subsequently passed the pure exported gate check, without Docker or SQL.
- Ready runner SHA256: `a8d88d1cb9cc2220d9f2bb7ccee80373a79a6b11b04062d53f1834d70c624e8c`.

Approved execution command (contains no database URL or credential):

```sh
env -i PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin HOME=/Users/lixiaomei LANG=C.UTF-8 NODE_ENV=test /opt/homebrew/Cellar/node@22/22.23.2/bin/node --import tsx artifacts/audit-2026-09-07/jit-revoke/run-authorization-postgres-isolated.ts
```

The run result, exact container IDs, PostgreSQL version, source hashes, six-file/eight-test denominator validation, and exact-ID disposal result will be retained in the run's private `postgres-run-*` directory. No generated connection URL or credential is intended to be retained.
