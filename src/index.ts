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

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    if (result.rows.length === 0) {
      console.log("No tables found in the 'public' schema.");
    } else {
      console.log(`Found ${result.rows.length} table(s): \n`);
      for (const row of result.rows) {
        console.log(`  - ${row.table_name}`);
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
