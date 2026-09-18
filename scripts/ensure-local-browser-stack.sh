#!/bin/sh
set -eu

# A successful HTTP response is not candidate identity: these documented
# ports may be SSH tunnels. The harness uses isolated ports/project/images
# and verifies Compose ownership plus API and static UI build identities.
exec node --import tsx scripts/merchant-browser-candidate.ts --ensure "$@"
