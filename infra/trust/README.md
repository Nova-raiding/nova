# Production evidence trust anchor

This directory intentionally contains only `UNPROVISIONED` sentinels. Files in the mutable source checkout are not a production trust anchor and `deploy-preflight.sh` rejects any trust directory inside the repository.

The protected deployment environment must mount a read-only directory outside the checkout and set `PRODUCTION_EVIDENCE_TRUST_DIR` to it. The directory contract is:

- `production-evidence-public.pem`: the organisation Ed25519 public key in SPKI PEM format; no private key may be present on the deployment runner.
- `production-evidence-key-id`: one line matching the `key_id` signed into payment and restore evidence.

Provisioning, key rotation, mount policy, and access review belong to the release-security control plane. Replacing the sentinels in this repository does not satisfy that control.
