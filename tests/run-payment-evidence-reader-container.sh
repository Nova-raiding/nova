#!/bin/sh
set -eu

# Isolated synthetic ACL test. No production connection or payment rows.
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
image=${PAYMENT_READER_TEST_IMAGE:-postgres:17-alpine}
case "$image" in *[!A-Za-z0-9._:/@-]*|'') echo 'invalid local PostgreSQL image reference' >&2; exit 1 ;; esac
name="payment-reader-review-$(date +%s)-$$"
docker run --rm -d --network none --tmpfs /var/lib/postgresql/data \
  --name "$name" -e POSTGRES_PASSWORD=reviewonly -e POSTGRES_DB=merchant "$image" >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
attempt=0
until docker exec "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 40 ] || { echo 'isolated PostgreSQL did not become ready' >&2; exit 1; }
  sleep 1
done
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE billing_orders (id text, workspace_id text, state text, payment_mode text, channel text, amount_fen bigint, provider_trade_id text, unused text);
CREATE TABLE billing_transactions (id text, workspace_id text, order_id text, type text, amount_fen bigint, unused text);
ALTER TABLE billing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_orders_workspace_isolation ON billing_orders USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE POLICY billing_transactions_workspace_isolation ON billing_transactions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
SQL
if docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 \
  < "$repo/infra/protected/payment-evidence-reader-bootstrap.sql" >/dev/null 2>&1; then
  echo 'bootstrap accepted inherited PUBLIC TEMPORARY privilege' >&2; exit 1
fi
[ "$(docker exec "$name" psql -U postgres -d merchant -X -qAt \
  -c "SELECT count(*) FROM pg_roles WHERE rolname='payment_evidence_reader'")" = 0 ] || {
  echo 'failed bootstrap left an observer role behind' >&2; exit 1;
}
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
REVOKE TEMPORARY ON DATABASE merchant FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;
SQL
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 \
  < "$repo/infra/protected/payment-evidence-reader-bootstrap.sql" >/dev/null
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
ALTER ROLE payment_evidence_reader PASSWORD 'reviewonly';
SQL
verify() {
  docker exec -i -e PGPASSWORD=reviewonly "$name" psql -h 127.0.0.1 \
    -U payment_evidence_reader -d merchant -X -qAt -v ON_ERROR_STOP=1 \
    < "$repo/infra/protected/verify-payment-evidence-reader.sql"
}
[ "$(verify)" = 'payment-evidence-reader:ok' ] || { echo 'minimal role failed verification' >&2; exit 1; }
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
GRANT SELECT ON billing_orders TO payment_evidence_reader;
SQL
[ "$(verify)" = 'payment-evidence-reader:fail' ] || { echo 'extra table SELECT was accepted' >&2; exit 1; }
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
REVOKE SELECT ON billing_orders FROM payment_evidence_reader;
GRANT SELECT (id, workspace_id, state, payment_mode, channel, amount_fen, provider_trade_id)
  ON billing_orders TO payment_evidence_reader;
CREATE POLICY billing_orders_extra ON billing_orders FOR SELECT TO payment_evidence_reader USING (true);
SQL
[ "$(verify)" = 'payment-evidence-reader:fail' ] || { echo 'extra RLS policy was accepted' >&2; exit 1; }
docker exec -i "$name" psql -U postgres -d merchant -X -qAt -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DROP POLICY billing_orders_extra ON billing_orders;
GRANT UPDATE (unused) ON billing_orders TO payment_evidence_reader;
SQL
[ "$(verify)" = 'payment-evidence-reader:fail' ] || { echo 'column write privilege was accepted' >&2; exit 1; }
echo 'payment evidence reader isolated PG17 ACL/RLS checks: PASS (review-only)'
