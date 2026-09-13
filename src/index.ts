import "dotenv/config";
import { Client } from "pg";

function isPermissive(expr: string | null): boolean {
  if (expr === null) return false;
  return expr.trim().toLowerCase() === "true";
}

function hasUnrestrictedRole(roles: string[]): boolean {
  return roles.includes("public") || roles.includes("anon");
}

function parseRoles(rolesRaw: string): string[] {
  return rolesRaw.replace(/^\{|\}$/g, "").split(",");
}

function getMissingOperations(policies: { cmd: string }[]): string[] {
  const allOps = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const covered = new Set(
    policies.map((p) => (p.cmd === "ALL" ? allOps : [p.cmd])).flat(),
  );
  return allOps.filter((op) => !covered.has(op));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("Error: DATABASE_URL environment variable is not set.");
    console.error("Make sure you have a .env file with DATABASE_URL set.");
    process.exit(1);
  }

  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log("Connected to database.\n");

    const failOnWarning = process.argv.includes("--fail-on-warning");
    let hasWarnings = false;

    const tableresult = await client.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    const policiesresult = await client.query(`
      SELECT tablename, policyname, cmd, qual, with_check, roles
      FROM pg_policies
      WHERE schemaname = 'public';
    `);

    const forceRlsResult = await client.query(`
      SELECT relname AS tablename, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
      AND relkind = 'r';
    `);

    const forceRlsByTable = new Map<string, boolean>();
    for (const row of forceRlsResult.rows) {
      forceRlsByTable.set(row.tablename, row.relforcerowsecurity);
    }

    const policiesByTable = new Map<string, typeof policiesresult.rows>();
    for (const row of policiesresult.rows) {
      const existing = policiesByTable.get(row.tablename) ?? [];
      existing.push(row);
      policiesByTable.set(row.tablename, existing);
    }

    if (tableresult.rows.length === 0) {
      console.log("No tables found in the 'public' schema.");
    } else {
      console.log(`Found ${tableresult.rows.length} table(s): \n`);
      for (const row of tableresult.rows) {
        const policies = policiesByTable.get(row.tablename) ?? [];
        const count = policies.length;

        let status: string;

        if (!row.rowsecurity) {
          status = "RLS DISABLED";
        } else if (count === 0) {
          status =
            "RLS enabled, 0 policies — WARNING: table is locked, nothing can access it";
        } else {
          status = `RLS enabled, ${count} polic${count === 1 ? "y" : "ies"}`;
        }

        if (row.rowsecurity && count > 0) {
          const missing = getMissingOperations(policies);
          if (missing.length > 0) {
            console.log(
              `      ℹ No policy covers: ${missing.join(", ")} — these operations are denied by default (may be intentional)`,
            );
          }

          const forced = forceRlsByTable.get(row.tablename) ?? false;
          if (!forced) {
            console.log(
              `      ℹ FORCE ROW LEVEL SECURITY is off — the table owner can bypass all policies on this table`,
            );
          }
        }

        console.log(`  - ${row.tablename}: ${status}`);

        for (const policy of policies) {
          if (isPermissive(policy.qual) || isPermissive(policy.with_check)) {
            hasWarnings = true;
            console.log(
              `      ⚠ Policy "${policy.policyname}" (${policy.cmd}) is overly permissive (USING true) — provides no real protection`,
            );
          }

          if (hasUnrestrictedRole(parseRoles(policy.roles))) {
            hasWarnings = true;
            console.log(
              `      ⚠ Policy "${policy.policyname}" (${policy.cmd}) applies to unauthenticated role(s) [${parseRoles(policy.roles).join(", ")}] — check if this should be restricted to 'authenticated'`,
            );
          }
        }
      }

      if (failOnWarning && hasWarnings) {
        console.log(
          "\nFailing build: warnings found and --fail-on-warning was set.",
        );
        process.exit(1);
      }
    }
  } catch (err) {
    console.error("Error connecting to database or running query");
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
