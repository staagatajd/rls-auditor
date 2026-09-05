import "dotenv/config";
import { Client } from "pg";

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
      SELECT tablename, COUNT(*) AS policy_count
      FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY tablename;
    `);

    const policyCounts = new Map<string, number>();
    for (const row of policiesresult.rows) {
      policyCounts.set(row.tablename, parseInt(row.policy_count, 10));
    }

    if (tableresult.rows.length === 0) {
      console.log("No tables found in the 'public' schema.");
    } else {
      console.log(`Found ${tableresult.rows.length} table(s): \n`);
      for (const row of tableresult.rows) {
        const count = policyCounts.get(row.tablename) ?? 0;

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
