# ChatGPT candidate host route (preproduction only)

The official local stdio plugin keeps `MERCHANT_MCP_BASE_URL=https://yxsona.com`; its bridge appends `/mcp`. Before cutover, the live 80/443 gateway still routes that origin to the old API. A direct ChatGPT host run against the public DNS therefore cannot prove the candidate release, even if the local bridge is new. Do not relabel that run as candidate evidence.

## Isolated route

1. Keep the current public gateway and DNS unchanged. Start the frozen candidate API with `launch-ecs-candidate-api.mjs` on its Compose network. On ECS as root, start the **separate** gateway with the protected frozen Compose and environment paths, the immutable `pilot-gateway` image reference from that Compose, exact candidate API container ID, and a free host-loopback port:

   ```sh
   node infra/scripts/launch-ecs-candidate-tls-gateway.mjs start \
     "$RENDERED_COMPOSE" "$CANDIDATE_ENV" "$COMPOSE_PROJECT" \
     "$PILOT_GATEWAY_IMAGE_REF" "$RELEASE_ID" "$CANDIDATE_API_CONTAINER_ID" 18443
   ```

   Capture its **full** Docker ID from stdout. The launcher checks the candidate API image, Compose ownership, one-off status, network and lack of published ports; it pins Nginx to that container's exact private IPv4 address. It publishes only `127.0.0.1:18443`, mounts the existing ECS `yxsona.com` certificate read-only, allows only `/releasez`, `/mcp`, and `/v1/auth/mcp-token/refresh`, and verifies `/releasez` over trusted TLS before returning the ID. Any identity/TLS failure stops the exact newly started gateway; it never removes containers or data. The local acceptance adapter checks release identity again before every authenticated request. Do not copy the private certificate key to the desktop.
2. Forward that isolated port to the desktop with `ssh -N -L 127.0.0.1:18443:127.0.0.1:18443 101`, bound to desktop loopback. Check with `curl --noproxy '*' --resolve yxsona.com:18443:127.0.0.1 https://yxsona.com:18443/releasez` **without** `-k`: the endpoint must present a valid public certificate for `yxsona.com` and report the frozen candidate release ID, full Git SHA, and image-set digest. The port is an example: use a distinct nonprivileged local port if occupied and put that port into the temporary route file. Do not alter `/etc/hosts` or install a machine-wide proxy.
3. Make a **temporary acceptance copy** of the local plugin. In that copy only, prepend Node's `--import /absolute/path/to/infra/scripts/chatgpt-candidate-fetch-route.mjs` to `.mcp.json` `args` before `./mcp/bridge.mjs`, and add `MERCHANT_CANDIDATE_ROUTE_FILE` to `env_vars`. Keep `mcp/bridge.mjs` byte-for-byte identical to the release artifact. Never publish this acceptance copy as a user installer.
4. Create an owner-only mode `0600` JSON route file at a canonical absolute path and pass its path to the ChatGPT app's launched bridge process as `MERCHANT_CANDIDATE_ROUTE_FILE`. Example shape (replace every identity value with the frozen release):

   ```json
   {
     "origin": "https://yxsona.com",
     "loopback_host": "127.0.0.1",
     "loopback_port": 18443,
     "expected_release_id": "release-...",
     "expected_git_sha": "40 lowercase hex characters",
     "expected_image_set_digest": "sha256:64 lowercase hex characters"
   }
   ```

   `MERCHANT_MCP_BASE_URL` must still be the canonical `https://yxsona.com` root origin. The adapter redirects only the process socket to the tunnel while preserving HTTPS SNI, certificate validation, and Host. It checks `/releasez` before **every** authenticated request; any wrong release, tunnel loss, certificate failure, redirect, unsupported path/origin, or missing route file stops the request before the Bearer token is sent. It does not inject fake API or ChatGPT responses.

5. In the **real** desktop ChatGPT/Codex host, run all 15 scenarios in [the host canary checklist](../chatgpt-host-canary-runbook.md). Record the temporary `.mcp.json` hash, route-file hash (not credentials), candidate gateway/container identity, SSH tunnel endpoints, bridge SHA, and each host screenshot/log/MCP trace in the capture artifacts. Label this as `preproduction`. `error_recovery` still requires a genuine `503 MODEL_PROVIDER_OUTCOME_UNKNOWN` and reconciliation. Passing source tests, the tunnel identity probe, or 14 of 15 scenarios is not host acceptance.
6. Tear down only the exact isolated gateway, tunnel, and temporary acceptance copy. Use `node infra/scripts/launch-ecs-candidate-tls-gateway.mjs stop` with the same seven start arguments followed by the captured full gateway ID; the launcher rechecks frozen gateway image, API binding, network and loopback publication before stopping that ID. Do not use `docker compose down` or remove containers/volumes. After production cutover, install the **unmodified** release plugin and replay host smoke against public DNS and the new `/releasez`; capture separate `production` evidence. The preproduction run is not proof of post-cutover routing.

The launcher and fail-closed process adapter are code and tests only. The isolated gateway has not been launched by this document, and no real desktop host scenario is claimed passed.
