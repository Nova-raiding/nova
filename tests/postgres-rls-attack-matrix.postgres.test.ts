import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { assertOwnedPostgresTestBinding } from "./fixtures/owned-postgres-binding.js";
import {
  loadMigrations,
  MigrationRunner,
} from "../packages/persistence/src/migration.js";

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL;
const base = assertOwnedPostgresTestBinding(
  databaseUrlValue,
  process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID,
);

const databaseConnection = (
  base: URL,
  database: string,
  user?: string,
  password?: string,
) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
};

const scopedReadTables = [
  { name: "workspaces", scopeColumn: "id", prefix: "rls_matrix_ws_" },
  { name: "brands", scopeColumn: "workspace_id", prefix: "rls_matrix_brand_" },
  {
    name: "platform_accounts",
    scopeColumn: "workspace_id",
    prefix: "rls_matrix_account_",
  },
  {
    name: "canonical_products",
    scopeColumn: "workspace_id",
    prefix: "rls_matrix_canonical_",
  },
  {
    name: "product_listings",
    scopeColumn: "workspace_id",
    prefix: "rls_matrix_listing_",
  },
] as const;

describe("PostgreSQL RLS cross-scope attack matrix", () => {
  it("keeps workspace, brand, account, canonical, and listing rows tenant isolated", async () => {
    const databaseName = `probe_rls_matrix_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: base.toString() });
    let database: Pool | undefined;
    let app: Pool | undefined;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      database = new Pool({
        connectionString: databaseConnection(base, databaseName),
      });
      await new MigrationRunner(database, await loadMigrations()).run();

      // The test grants only the table privileges needed to exercise RLS. It
      // does not change policies, migrations, or the role's bypass settings.
      await database.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON workspaces, brands, platform_accounts, brand_store_bindings, canonical_products, product_listings TO merchant_app`,
      );

      await database.query(`
        INSERT INTO workspaces (id, status) VALUES
          ('rls_matrix_ws_a', 'active'), ('rls_matrix_ws_b', 'active')
      `);
      await database.query(`
        INSERT INTO platform_accounts (id, workspace_id, platform, remote_account_id, credential_ref, token_state) VALUES
          ('rls_matrix_account_a', 'rls_matrix_ws_a', 'jd', 'remote-a', 'credential-a', 'valid'),
          ('rls_matrix_account_b', 'rls_matrix_ws_b', 'jd', 'remote-b', 'credential-b', 'valid')
      `);
      await database.query(`
        INSERT INTO brands (id, workspace_id, name) VALUES
          ('rls_matrix_brand_a', 'rls_matrix_ws_a', 'Brand A'),
          ('rls_matrix_brand_b', 'rls_matrix_ws_b', 'Brand B')
      `);
      await database.query(`
        INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id) VALUES
          ('rls_matrix_ws_a', 'rls_matrix_brand_a', 'jd', 'rls_matrix_account_a'),
          ('rls_matrix_ws_b', 'rls_matrix_brand_b', 'jd', 'rls_matrix_account_b')
      `);
      await database.query(`
        INSERT INTO canonical_products (id, workspace_id, brand_id, title) VALUES
          ('rls_matrix_canonical_a', 'rls_matrix_ws_a', 'rls_matrix_brand_a', 'Canonical A'),
          ('rls_matrix_canonical_b', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'Canonical B')
      `);
      await database.query(`
        INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, state) VALUES
          ('rls_matrix_listing_a', 'rls_matrix_ws_a', 'rls_matrix_brand_a', 'rls_matrix_canonical_a', 'jd', 'rls_matrix_account_a', 'active'),
          ('rls_matrix_listing_b', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'rls_matrix_canonical_b', 'jd', 'rls_matrix_account_b', 'active')
      `);

      const appUrl = new URL(
        databaseConnection(
          base,
          databaseName,
          "merchant_app",
          "merchant_app_local_only",
        ),
      );
      app = new Pool({ connectionString: appUrl.toString(), max: 2 });

      for (const workspaceId of ["rls_matrix_ws_a", "rls_matrix_ws_b"]) {
        const client = await app.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.workspace_id', $1, true)",
            [workspaceId],
          );

          for (const table of scopedReadTables) {
            const expectedId = `${table.prefix}${workspaceId.endsWith("_a") ? "a" : "b"}`;
            const result = await client.query(
              `SELECT id FROM ${table.name} WHERE ${table.scopeColumn} = $1 ORDER BY id`,
              [workspaceId],
            );
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(expectedId);

            const allRows = await client.query(
              `SELECT id FROM ${table.name} ORDER BY id`,
            );
            expect(
              allRows.rows,
              `${table.name} leaked across ${workspaceId}`,
            ).toEqual([{ id: expectedId }]);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }

      // A forged workspace_id must be rejected by WITH CHECK, even when the
      // caller knows valid foreign keys from the other tenant.
      const brandAttackClient = await app.connect();
      try {
        await brandAttackClient.query("BEGIN");
        await brandAttackClient.query(
          "SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)",
        );
        await brandAttackClient.query("SAVEPOINT rls_attack_probe");
        await expect(
          brandAttackClient.query(
            `INSERT INTO brands (id, workspace_id, name) VALUES ('rls_matrix_attack_brand', 'rls_matrix_ws_b', 'forged')`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await brandAttackClient.query("ROLLBACK TO SAVEPOINT rls_attack_probe");
        await brandAttackClient.query("COMMIT");
      } catch (error) {
        await brandAttackClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        brandAttackClient.release();
      }

      const listingAttackClient = await app.connect();
      try {
        await listingAttackClient.query("BEGIN");
        await listingAttackClient.query(
          "SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)",
        );
        await listingAttackClient.query("SAVEPOINT rls_attack_probe");
        await expect(
          listingAttackClient.query(
            `INSERT INTO product_listings (id, workspace_id, brand_id, canonical_product_id, platform, platform_account_id, state)
           VALUES ('rls_matrix_attack_listing', 'rls_matrix_ws_b', 'rls_matrix_brand_b', 'rls_matrix_canonical_b', 'jd', 'rls_matrix_account_b', 'active')`,
          ),
        ).rejects.toMatchObject({ code: "42501" });
        await listingAttackClient.query(
          "ROLLBACK TO SAVEPOINT rls_attack_probe",
        );
        await listingAttackClient.query("COMMIT");
      } catch (error) {
        await listingAttackClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        listingAttackClient.release();
      }

      // UPDATE/DELETE silently filtering a foreign row is PostgreSQL's normal
      // RLS behavior. Assert RETURNING is empty so a regression that exposes
      // or mutates the other tenant's listing cannot pass on a successful
      // command alone.
      const mutationAttackClient = await app.connect();
      try {
        await mutationAttackClient.query("BEGIN");
        await mutationAttackClient.query(
          "SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)",
        );

        const crossTenantUpdate = await mutationAttackClient.query(
          `UPDATE product_listings SET state = state WHERE id = 'rls_matrix_listing_b' RETURNING id`,
        );
        expect(
          crossTenantUpdate.rows,
          "workspace A updated workspace B listing",
        ).toEqual([]);

        const crossTenantDelete = await mutationAttackClient.query(
          `DELETE FROM product_listings WHERE id = 'rls_matrix_listing_b' RETURNING id`,
        );
        expect(
          crossTenantDelete.rows,
          "workspace A deleted workspace B listing",
        ).toEqual([]);
        await mutationAttackClient.query("COMMIT");
      } catch (error) {
        await mutationAttackClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        mutationAttackClient.release();
      }

      const foreignListing = await database.query(
        `SELECT id FROM product_listings WHERE id = 'rls_matrix_listing_b'`,
      );
      expect(foreignListing.rows).toEqual([{ id: "rls_matrix_listing_b" }]);

      await expect(
        app.query(
          "SELECT set_config('app.workspace_id', 'rls_matrix_ws_a', true)",
        ),
      ).resolves.toBeDefined();
      const unscoped = await app.query(
        "SELECT id FROM product_listings ORDER BY id",
      );
      expect(unscoped.rows).toEqual([]);
    } finally {
      await app?.end();
      await database?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  }, 240_000);
});
