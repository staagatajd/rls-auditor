import "dotenv/config";
import { Client } from "pg";

function isPermissive(expr: string | null): boolean {
  if (expr === null) return false;
  return expr.trim().toLowerCase() === "true";
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

    const tableresult = await client.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    const policiesresult = await client.query(`
      SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public';
    `);

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

        console.log(`  - ${row.tablename}: ${status}`);

        for (const policy of policies) {
          if (isPermissive(policy.qual) || isPermissive(policy.with_check)) {
            console.log(
              `      ⚠ Policy "${policy.policyname}" (${policy.cmd}) is overly permissive (USING true) — provides no real protection`
            );
          }
        }
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