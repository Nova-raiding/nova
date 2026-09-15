import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guard = resolve("infra/local/proxy-health-guard.sh");

type FixtureOptions = {
  listener?: boolean;
  fdCount?: number;
  httpStatus?: string;
  socksStatus?: string;
};

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "proxy-health-guard-"));
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const calls = join(root, "calls.log");
  const marker = join(root, "started");
  const listener = options.listener ?? true;
  const fdCount = options.fdCount ?? 12;
  const httpStatus = options.httpStatus ?? "200";
  const socksStatus = options.socksStatus ?? "200";

  const addStub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  const lsof = addStub(
    "lsof",
    `case " $* " in
      *" -iTCP@"*)
        if [ ${listener ? "1" : "0"} -eq 1 ] || [ -f "${marker}" ]; then printf '4242\\n'; fi
        ;;
      *" -Ff "*)
        i=0
        while [ "$i" -lt ${fdCount} ]; do printf 'f%s\\n' "$i"; i=$((i + 1)); done
        ;;
    esac`,
  );
  const ps = addStub("ps", "printf '/test/bin/xray\\n'");
  const curl = addStub(
    "curl",
    `case " $* " in
      *"--proxy http://"*) printf '${httpStatus}' ;;
      *"--proxy socks5h://"*) printf '${socksStatus}' ;;
      *) exit 9 ;;
    esac`,
  );
  const open = addStub(
    "open",
    `env | sort > "${root}/launch-env.log"
    : > "${marker}"
    printf 'open\\n' >> "${calls}"`,
  );
  const sleep = addStub("sleep", ":");

  const env = {
    ...process.env,
    PROXY_GUARD_STATE_DIR: join(root, "state"),
    PROXY_GUARD_CURL_BIN: curl,
    PROXY_GUARD_LSOF_BIN: lsof,
    PROXY_GUARD_PS_BIN: ps,
    PROXY_GUARD_OPEN_BIN: open,
    PROXY_GUARD_SLEEP_BIN: sleep,
    PROXY_GUARD_SETTLE_SECONDS: "0",
    PROXY_GUARD_V2RAYN_APP: root,
    PROXY_GUARD_HEALTH_URL: "https://health.invalid/secret-path",
    SECRET_THAT_MUST_NOT_LEAK: "top-secret",
  };

  return { root, calls, marker, env };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync("/bin/sh", [guard], { env, encoding: "utf8" });
}

describe("local proxy health guard", () => {
  it("requires successful HTTP and SOCKS probes through the configured ports", () => {
    const ok = fixture();
    const result = run({
      ...ok.env,
      PROXY_GUARD_HTTP_PORT: "10808",
      PROXY_GUARD_SOCKS_PORT: "10809",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("event=healthy");
    expect(result.stdout).toContain("protocols=http,socks");

    const stale = fixture({ socksStatus: "000" });
    const failed = run(stale.env);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("reason=stale");
    expect(failed.stdout).not.toContain("health.invalid");
    expect(failed.stdout).not.toContain("top-secret");
  });

  it("fails closed for a high-FD xray when no restart owner is configured", () => {
    const highFd = fixture({ fdCount: 220 });
    const result = run(highFd.env);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("reason=high_fd");
    expect(result.stdout).toContain("fd_count=220");
    expect(result.stdout).toContain("recovery=not_configured");
  });

  it("starts a dead v2rayN app with a sanitized environment and verifies recovery", () => {
    const dead = fixture({ listener: false });
    const result = run({ ...dead.env, PROXY_GUARD_START_V2RAYN: "1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("method=sanitized_v2rayn_start");
    expect(result.stdout).toContain("event=recovered");

    const launchEnv = readFileSync(join(dead.root, "launch-env.log"), "utf8");
    expect(launchEnv).not.toContain("SECRET_THAT_MUST_NOT_LEAK");
    expect(launchEnv).not.toContain("top-secret");
    expect(launchEnv).not.toContain("HTTP_PROXY");
    expect(launchEnv).not.toContain("MERCHANT_");
    expect(launchEnv).toContain("PATH=/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("serializes checks and applies a recovery cooldown", () => {
    const highFd = fixture({ fdCount: 220 });
    execFileSync("mkdir", ["-p", join(highFd.root, "state", "lock")]);
    writeFileSync(join(highFd.root, "state", "lock", "pid"), `${process.pid}\n`);

    const locked = run(highFd.env);
    expect(locked.status).toBe(0);
    expect(locked.stdout).toContain("event=already_running");

    execFileSync("rm", ["-f", join(highFd.root, "state", "lock", "pid")]);
    execFileSync("rmdir", [join(highFd.root, "state", "lock")]);
    writeFileSync(join(highFd.root, "state", "last-recovery"), `${Math.floor(Date.now() / 1000)}\n`);

    const cooldown = run({
      ...highFd.env,
      PROXY_GUARD_RESTART_COMMAND: `printf restart >> '${highFd.calls}'`,
    });
    expect(cooldown.status).toBe(1);
    expect(cooldown.stdout).toContain("event=recovery_cooldown");
  });
});
