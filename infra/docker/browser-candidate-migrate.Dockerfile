# Same PostgreSQL major/digest as the isolated fixture; source is frozen by harness.
FROM postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
COPY packages/persistence/src/migrations /migrations
COPY infra/scripts/apply-migrations.sh /ops/apply-migrations.sh
COPY infra/local/ensure-app-role.sql /ops/ensure-app-role.sql
COPY infra/scripts/verify-runtime-db-role.sh /ops/verify-runtime-db-role.sh
COPY infra/local/seed-demo.sql /ops/seed-demo.sql
RUN test -f /ops/ensure-app-role.sql \
    && test -f /ops/apply-migrations.sh \
    && test -f /ops/verify-runtime-db-role.sh \
    && test -f /ops/seed-demo.sql \
    && test -f /migrations/001_initial.sql
