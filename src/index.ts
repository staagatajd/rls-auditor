#!/usr/bin/env node
import "dotenv/config";
import { Client } from "pg";
import type { TableResult } from "./TableResult.js";

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

    const failOnWarning = process.argv.includes("--fail-on-warning");
    const jsonOutput = process.argv.includes("--json");
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

    const results: TableResult[] = [];

    for (const row of tableresult.rows) {
      const policies = policiesByTable.get(row.tablename) ?? [];
      const count = policies.length;

      const result: TableResult = {
        tablename: row.tablename,
        rlsEnabled: row.rowsecurity,
        policyCount: count,
        warnings: [],
        notes: [],
      };

      if (row.rowsecurity && count === 0) {
        result.warnings.push(
          "RLS enabled with 0 policies — table is locked, nothing can access it",
        );
        hasWarnings = true;
      }

      if (row.rowsecurity && count > 0) {
        const missing = getMissingOperations(policies);
        if (missing.length > 0) {
          result.notes.push(
            `No policy covers: ${missing.join(", ")} — these operations are denied by default (may be intentional)`,
          );
        }

        const forced = forceRlsByTable.get(row.tablename) ?? false;
        if (!forced) {
          result.notes.push(
            "FORCE ROW LEVEL SECURITY is off — the table owner can bypass all policies on this table",
          );
        }
      }

      for (const policy of policies) {
        if (isPermissive(policy.qual) || isPermissive(policy.with_check)) {
          result.warnings.push(
            `Policy "${policy.policyname}" (${policy.cmd}) is overly permissive (USING true) — provides no real protection`,
          );
          hasWarnings = true;
        }

        if (hasUnrestrictedRole(parseRoles(policy.roles))) {
          result.warnings.push(
            `Policy "${policy.policyname}" (${policy.cmd}) applies to unauthenticated role(s) [${parseRoles(policy.roles).join(", ")}] — check if this should be restricted to 'authenticated'`,
          );
          hasWarnings = true;
        }
      }

      results.push(result);
    }

    if (jsonOutput) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log("Connected to database.\n");
      if (results.length === 0) {
        console.log("No tables found in the 'public' schema.");
      } else {
        console.log(`Found ${results.length} table(s):\n`);
        for (const r of results) {
          const status = !r.rlsEnabled
            ? "RLS DISABLED"
            : `RLS enabled, ${r.policyCount} polic${r.policyCount === 1 ? "y" : "ies"}`;

          for (const note of r.notes) {
            console.log(`      ℹ ${note}`);
          }

          console.log(`  - ${r.tablename}: ${status}`);

          for (const warning of r.warnings) {
            console.log(`      ⚠ ${warning}`);
          }
        }
      }
    }

    if (failOnWarning && hasWarnings) {
      if (!jsonOutput) {
        console.log(
          "\nFailing build: warnings found and --fail-on-warning was set.",
        );
      }
      process.exit(1);
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
