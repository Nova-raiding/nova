# Archived: 101 isolated merchant browser candidate

> **Historical procedure only. Do not execute for the current project.** This
> runbook describes creating a second `merchant-demo-*` environment and keeping
> its volumes. The project now authorizes work only against the existing
> `merchant-demo-85575f9c` Demo; creating another environment or retaining new
> environment data is outside the current deployment scope. Its migration
> examples (254–256) are stale and do not describe the current 270→273 source
> candidate; the Demo live chain remains unverified.
> Use `ecs-demo-direct-deploy.md` and `ecs-fast-update.md` for the current
> gates; the current source candidate ends at migration 273, while the live
> Demo migration chain remains unverified. Those runbooks stop deployment until
> current inventory, candidate, migration and approval evidence is complete. This archive is retained only
> to explain old review records and must not be used to bypass those gates.

This is a preproduction candidate for merchant member browser checks. It does not
modify `merchant-demo-85575f9c`, host 80/443, a production database, or a worker.
Do not treat its result as a production release approval.

1. Freeze a reviewed **clean commit** that includes the candidate renderer and
   attester. Build the release images from the exact committed candidate archive
   using the shared ECS build lock. Record the full Git SHA, source archive SHA,
   six-image manifest, eight-image set, and immutable API/UI image references.
   A source archive made from an earlier commit cannot exercise later candidate
   safeguards, even if the operator's working tree has them.
2. Stage that exact archive outside every live checkout, with root-owned
   `0700` directories and root-owned `0600` identity, manifests and relay env.
   The relay env must contain a real configured `MODEL_RELAY_API_KEY`; the
   renderer rejects a placeholder. Select a new `merchant-demo-*` project,
   unique from every existing candidate. Call
   `render-ecs-demo-candidate.mjs` with the documented identity, image set,
   source root, env and project arguments, plus `--merchant-ui enabled`.
   The protected output has five services: PG17, Redis, one-shot migration,
   API and merchant UI. It uses new project volumes, a private network, no
   published host ports, and no worker. The manifest records the contiguous
   SQL migration tail from the frozen archive and must equal that archive's
   `release-metadata.json.expectedMigrationVersion` exactly (256 for candidate
   `52d79f52`). Do not start the candidate until the renderer, attester, and
   review tools bind and test that same target.
3. Before `docker compose up`, inspect the rendered Compose and run
   `validateDemoCompose` plus Docker Compose config validation. Check that
   `ui` and `api` use the same immutable release identity and that the
   migration bind paths point only inside the frozen source root. Start only
   `postgres redis migrate api ui` in the new Compose project. The migration
   job must finish with exit 0. Never direct it to a live database URL.
4. Run `attest-ecs-demo-isolated-runtime.mjs` against the protected Compose,
   identity and manifest. It checks exact project container and image IDs,
   private network and no host ports, PG17 migration prefix matching the frozen
   metadata target (256 for candidate `52d79f52`) and RLS roles,
   API health, expected production readiness blocks, UI health and the UI
   `build-meta.json` release identity. Preserve its review-only result. A
   `readyz` 503 caused by unavailable release gates remains a block for
   production, even when this isolated member flow passes.
5. From the desktop, forward a local loopback port through SSH to the **exact
   attested candidate UI container's private IPv4** and port 8080. Read that
   IP from the attested container ID immediately before creating the tunnel;
   reject an identity or network change. The tunnel is private to the desktop
   and avoids publishing any new ECS host port. Run Chrome Playwright against
   this forwarded origin. Verify the UI `build-meta.json` and same-origin
   `/api/releasez` still match the frozen candidate before login. Use only a
   new test merchant account and workspace in the candidate PG17 database.
   Exercise login, list, four concurrent MCP token issuances, invite, role
   change, suspension, and persisted results; capture browser errors and
   screenshots. The existing `verify-merchant-members-isolated.ts` provisions
   its own **local** fixture, so its success is not 101 browser evidence.
6. Stop only the exact owned candidate containers and SSH tunnel after
   evidence collection. Retain volumes and protected artifacts for review.
   Do not run `docker compose down -v`, alter the live Compose, or reuse the
   candidate credentials for production.

The older four-service candidate and its 254 attestation remain valid for their
original frozen releases. The new UI mode does not make the old a3e99e31
archive deployable: the renderer/attester changes must first be reviewed and
committed, followed by a new frozen candidate identity and image build.

The Ops review sidecar accepts the candidate manifest's positive migration tail
and requires the PG17 attestation to match it exactly; 255 and 256 contracts are
covered by unit tests. It still does not independently read `release-metadata`
or the source archive, so before using it, the reviewed candidate renderer and
archive identity must prove that the manifest tail came from the same frozen
candidate metadata. Passing an isolated candidate remains review-only and does
not approve either production migration stage 254→255 or 255→256.
