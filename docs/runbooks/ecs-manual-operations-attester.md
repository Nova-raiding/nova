# Manual operations capability evidence on ECS

In the current `manual` release profile, `CAPABILITY_EVIDENCE_PATH` is a signed `manual-operations-evidence/2` source file. The unsigned candidate comes from `infra/scripts/capture-manual-operations-evidence.sh`, which observes the deployed release identity, validates the authenticated tenant-scoped `publish.manual.list` read contract (an empty list is valid), and requires a foreign workspace request to fail. It does not require a manual publish record and does not claim an official platform API receipt. This route is separate from the future `official_api` capability attester.

Install reviewed `infra/protected/attest-manual-operations-evidence.mjs` through `install-ecs-release-controls.mjs --control manual` from the exact release commit. Its installed executable is `/usr/local/libexec/merchant/attest-manual-operations-evidence`, and the fixed digest receipt is `/run/release-security/evidence-trust/production-manual-operations-attester-sha256`. Use the reviewed protected Node runtime and verify both digest and ownership before executing it, following the release evidence bundle attester installation procedure. Do not execute the signer from the mutable repository.

After capture, invoke the protected executable as root with `attest --input <unsigned-candidate> --output <new-signed-evidence> --release-id <id> --image-set-digest <sha256:...> --manifest-sha256 <rendered-compose-sha256> --release-git-sha <sha> --deployment-nonce <nonce>`. The output is exclusive-create and must be a new path in a canonical, protected directory. The signer uses the existing root-owned `0600` production capability private key and fixed production evidence public key. It never creates keys or replaces evidence. Failed captures and signing attempts should remain as separate diagnostic attempts.

The signer checks the manual workflow boundary and the three expected observations, then binds release ID, image set, rendered Compose manifest, Git SHA, deployment nonce, and trusted key ID into its Ed25519 signature. The production manual gate requires the same bindings and fixed trust anchor. The release manifest binds the exact signed file by hash and path, and the evidence bundle binds that same artifact. A local fixture or unsigned candidate cannot satisfy the production gate.

The signing key proves that the protected host accepted the candidate. The candidate capture process must still be run against the intended runtime endpoint with authorized workspace credentials; a signature alone cannot prove the HTTP responses came from the real service. Preserve the capture logs and release identity observation as deployment evidence.

The capture journal stores only a minimal, redacted projection of each observation. Its SHA-256 values cover those projected fields, not the raw HTTP response bodies, which are deleted after capture. Do not describe the journal digest or the signer as independent proof of HTTP response provenance; provenance depends on running the reviewed capture script against the exact candidate container described in the release runbook and retaining the operator's capture log.

After signing, run the [runtime evidence handoff](ecs-runtime-evidence-handoff.md)
for the capability file before rendering Compose. The signer output remains
root-only `0600` at `CAPABILITY_EVIDENCE_PATH`; the handoff creates the
release-scoped `root:10001 0440` file at `CAPABILITY_RUNTIME_EVIDENCE_PATH`
without changing its bytes. The manifest and bundle gates use the source file;
the API bind mount uses only the runtime handoff.
