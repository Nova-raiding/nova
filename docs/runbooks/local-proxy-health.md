# Local proxy health guard

The local desktop browser uses v2rayN/xray. A listening proxy socket is not a
sufficient health check: xray can retain the listener while forwarding stalls,
especially when its inherited file-descriptor limit is close to exhaustion.

`infra/local/proxy-health-guard.sh` verifies all of the following:

- an `xray` process owns the configured HTTP listener;
- a real HTTPS request succeeds through the HTTP proxy;
- a real HTTPS request succeeds through the SOCKS proxy;
- xray remains below the configured file-descriptor threshold.

The default health endpoint is the IANA-reserved `https://example.com/` and the
expected status is `200`. The URL is never written to logs. Both protocols
default to v2rayN's current mixed inbound at `127.0.0.1:10808`. If v2rayN is
later configured with a dedicated SOCKS inbound on `10809`, set
`PROXY_GUARD_SOCKS_PORT=10809`.

## Recovery policy

The guard does not kill processes, edit v2rayN configuration, toggle macOS
network settings, or load the legacy standalone xray LaunchAgent.

- Healthy checks exit `0`.
- Unhealthy checks exit `1` and log only a reason, PID, FD count, and counters.
- Stale forwarding must fail three consecutive checks before recovery.
- A dead listener or FD count at/above `220` is actionable immediately.
- Recoveries are serialized and have a five-minute cooldown.
- With `PROXY_GUARD_START_V2RAYN=1`, a dead app may be opened using an empty,
  explicit environment. Project tokens and proxy variables are not inherited.
- Stale or high-FD processes fail closed unless an operator supplies a tested
  `PROXY_GUARD_RESTART_COMMAND`. v2rayN does not expose a stable repository-owned
  restart API, so the guard will not guess with broad `pkill` commands.

If an operator configures `PROXY_GUARD_RESTART_COMMAND`, it runs with only
`HOME`, `USER`, `LOGNAME`, `PATH`, and `TMPDIR`. Do not put credentials in that
command because LaunchAgent configuration and process arguments are observable.

## Install on macOS

Installation changes external user state, so it is intentionally manual:

1. Confirm v2rayN is the only owner of `127.0.0.1:10808`. Do not also load
   `org.xray.xray`; two owners will contend for the same port.
2. Run the guard once from a clean shell and confirm both protocol checks pass:

   ```sh
   env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" \
     PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$TMPDIR" \
     /absolute/path/to/codexSkills/infra/local/proxy-health-guard.sh
   ```

3. Copy `infra/local/com.merchant.proxy-health-guard.plist.example` to
   `~/Library/LaunchAgents/com.merchant.proxy-health-guard.plist` and replace
   `/ABSOLUTE/PATH/TO/codexSkills` with the checked-out repository path.
4. Validate the copy with `plutil -lint`, then bootstrap it with the normal
   per-user `launchctl bootstrap gui/$(id -u) ...` workflow.
5. Inspect `/tmp/merchant-proxy-health.log`. A healthy line must name both
   `http,socks`; no server address, health URL, environment value, or request
   body should appear.

Keep v2rayN's own auto-start setting enabled. Start it from Finder, a login
item, or this guard's sanitized dead-process recovery—not from a development
shell containing application credentials. Rotate any credentials that were
previously inherited by a GUI process.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROXY_GUARD_HTTP_PORT` | `10808` | HTTP or mixed inbound |
| `PROXY_GUARD_SOCKS_PORT` | HTTP port | SOCKS or mixed inbound |
| `PROXY_GUARD_HEALTH_URL` | `https://example.com/` | Neutral HTTPS probe |
| `PROXY_GUARD_EXPECTED_STATUS` | `200` | Required HTTP status |
| `PROXY_GUARD_FD_THRESHOLD` | `220` | Pre-exhaustion recovery threshold |
| `PROXY_GUARD_FAILURE_THRESHOLD` | `3` | Consecutive stale checks |
| `PROXY_GUARD_COOLDOWN_SECONDS` | `300` | Minimum time between recoveries |
| `PROXY_GUARD_START_V2RAYN` | `0` | Allow sanitized start when dead |
| `PROXY_GUARD_RESTART_COMMAND` | empty | Explicit stale/high-FD recovery hook |

Do not enable xray multiplexing solely to hide FD pressure. It changes transport
behavior and should be evaluated separately with throughput and latency evidence.
