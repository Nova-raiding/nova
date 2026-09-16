# ECS release evidence bundle attester

`infra/protected/attest-release-evidence-bundle.mjs` is source for an independently installed, root-owned executable at `/usr/local/libexec/merchant/attest-release-evidence-bundle`. The deploy runner must not execute it from the mutable repository and must never receive `/var/lib/merchant-release-security/production-evidence-bundle-private.pem`.

The attester accepts exactly eight evidence files: capability, capacity, model relay, payment, restore, object storage, Codex app host, and canonical cutover. Every file must be a fresh JSON artifact below the canonical protected artifact root, must not be a symlink, and must bind the requested release ID. It emits one Ed25519-signed document containing the exact SHA-256 reference for each file and one common release ID, image-set digest, release-manifest SHA-256, Git SHA, deployment nonce, key ID, generation time, and 24-hour expiry. Duplicate references are rejected and output is created atomically without replacement.

The release manifest declares `productionEvidenceBundle.required=true` and schema `release-evidence-bundle/1`. During ECS preflight, the bundle gate reads the exact release-manifest bytes, verifies their SHA-256 against the bundle binding, and requires all eight `productionEvidence` references to equal the signed bundle artifact references. This avoids a circular bundle hash inside the manifest while still providing two-way verification: the manifest requires the bundle and names its evidence; the signed bundle binds the exact manifest bytes and the same evidence. Object-storage evidence also retains its independent Ed25519 signature, while the bundle supplies the common signature boundary for capacity, model relay, and canonical cutover evidence.

Provision the final executable bytes outside the repository, root-owned and not group/other writable. Store their reviewed SHA-256 as `/run/release-security/evidence-trust/production-evidence-bundle-attester-sha256`; the trust directory is rebuilt independently after reboot. The executable, every parent directory, public key, private key, and digest file must be regular non-symlink paths with protected ownership and modes.

Install the reviewed bytes from the exact release commit before loading any private key. Run this from a root-owned release checkout after independently comparing the source hash with the release manifest:

```sh
install -d -o root -g root -m 0755 /usr/local/libexec/merchant
test ! -L /usr/local/libexec/merchant/attest-release-evidence-bundle
install -o root -g root -m 0755 infra/protected/attest-release-evidence-bundle.mjs /usr/local/libexec/merchant/attest-release-evidence-bundle
install -d -o root -g root -m 0755 /run/release-security/evidence-trust
sha256sum /usr/local/libexec/merchant/attest-release-evidence-bundle | awk '{print "sha256:" $1}' > /run/release-security/evidence-trust/production-evidence-bundle-attester-sha256
chown root:root /run/release-security/evidence-trust/production-evidence-bundle-attester-sha256
chmod 0444 /run/release-security/evidence-trust/production-evidence-bundle-attester-sha256
```

`validate-production-evidence-trust.sh` checks the installed executable against that digest during the release gate. Installation does not create or copy a private key; key provisioning remains a separate host security operation.

After independent evidence producers finish, the protected process signs the bundle. Set `RELEASE_EVIDENCE_BUNDLE_PATH` to that immutable output. `deploy-preflight-ecs.sh` then validates the signature, lifetime, exact eight artifact hashes, exact paths supplied to deployment, common release/image/manifest/Git/nonce binding, duplicate references, symlinks, and path escape before deployment can proceed. Unit fixtures exercise this contract only; they are not production evidence and do not provision a production private key.
