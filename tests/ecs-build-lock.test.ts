import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const helper = join(process.cwd(), "infra/scripts/ecs-build-lock.sh");

function contender(lockPath: string, holdMs: number) {
  const script = `set -eu
. ${JSON.stringify(helper)}
ecs_build_lock_acquire
sleep ${holdMs / 1000}
`;
  return spawnSync("sh", ["-c", script], {
    env: { ...process.env, ECS_BUILD_LOCK_PATH: lockPath },
    encoding: "utf8",
  });
}

describe("shared ECS source build lock", () => {
  it("rejects a real concurrent contender then releases for the next build", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ecs-build-lock-")));
    chmodSync(root, 0o700);
    const lock = join(root, "build.lock");
    const first = spawn("sh", ["-c", `set -eu; . ${JSON.stringify(helper)}; ecs_build_lock_acquire; printf ready; read release`], {
      env: { ...process.env, ECS_BUILD_LOCK_PATH: lock },
    });
    const finished = new Promise<number | null>(resolve => first.once('exit', resolve));
    await new Promise<void>((resolve, reject) => {
      first.stdout.once('data', () => resolve());
      first.once('error', reject);
      first.once('exit', code => reject(new Error(`holder exited before readiness: ${code}`)));
    });
    try {
      const second = contender(lock, 1);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain("another ECS source build is in progress");
    } finally { first.stdin.end('release\n'); }
    expect(await finished).toBe(0);
    const next = contender(lock, 1);
    expect(next.status, next.stderr).toBe(0);
  });

  it('does not evaluate shell syntax in a lock filename', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ecs-build-lock-literal-')));
    const marker = join(root, 'UNEXPECTED');
    const lock = join(root, '$(touch UNEXPECTED).lock');
    const result = spawnSync('sh', ['-c', `set -eu; . ${JSON.stringify(helper)}; ecs_build_lock_acquire`], {
      cwd: root, env: { ...process.env, ECS_BUILD_LOCK_PATH: lock }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects an unsafe symlink lock path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ecs-build-lock-")));
    const target = join(root, "target");
    const link = join(root, "build.lock");
    writeFileSync(target, "protected\n");
    execFileSync("ln", ["-s", target, link]);
    const result = contender(link, 1);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be a symlink");
  });
});
