# ECS candidate API sidecar

Use this only after rendering and validating the frozen production Compose JSON. The rendered file and candidate environment file must both be canonical, root-owned `0600` files outside the mutable release checkout. The API image must already exist locally by its reviewed `repository@sha256:...` reference.

On host `101`, start one API instance in the production Compose project without starting dependencies, migrating the database, or publishing host ports:

```sh
container_id=$(node infra/scripts/launch-ecs-candidate-api.mjs start \
  /var/lib/merchant-release-security/deployments/<release-id>/rendered-compose.json \
  /var/lib/merchant-release-security/deployments/<release-id>/production-compose.env \
  merchant-production '<api-repository>@sha256:<64-hex-digest>' '<release-id>')
```

The command prints only the full 64-character Docker ID. It verifies the frozen API environment has production mode, ECS profile, real database URLs, disabled fixtures, disabled startup migrations, and the requested immutable image and release ID. After start it checks the one-off Compose project/service labels, exact local image ID, running state, and absence of host port bindings. No `--service-ports` or network alias is used.

Use this ID as `MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID` for `capture-manual-operations-evidence.sh` and the same image reference as `MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF`. The evidence capture checks `/releasez` from inside the candidate container before sending a Bearer token. Keep the sidecar running through all candidate observations.

Stop only the exact reviewed one-off container after capture:

```sh
node infra/scripts/launch-ecs-candidate-api.mjs stop \
  /var/lib/merchant-release-security/deployments/<release-id>/rendered-compose.json \
  /var/lib/merchant-release-security/deployments/<release-id>/production-compose.env \
  merchant-production '<api-repository>@sha256:<64-hex-digest>' '<release-id>' "$container_id"
```

Stop retains the container, volumes, database, and evidence for diagnosis. Record the full ID in the release log; a later removal of that stopped container requires separate review. If startup or identity validation fails, treat candidate evidence as blocked. Do not use the public endpoint as a substitute before cutover.
