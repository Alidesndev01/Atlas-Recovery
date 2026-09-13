// src/ingest.js
// Reads a CSV of debtor records and loads them into the database.
//
// Usage:
//   npm run ingest                     -> reads ./atlas_inventory.csv
//   npm run ingest ./path/to/file.csv  -> reads a specific file
//
// Design decisions (also documented in the README):
//   * Duplicate account_number -> WE OVERWRITE (upsert). The newest upload wins,
//     because Atlas periodically re-uploads their latest inventory.
//   * A row missing account_number -> SKIPPED (we can't identify the account).
//   * A row with a non-numeric balance -> SKIPPED and reported.
//   * We never crash on one bad row. We process everything we can and print a
//     summary at the end so a human can see exactly what was accepted/rejected.

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { db } = require("./db");

// 1. Figure out which file to read.
const inputArg = process.argv[2];
const csvPath = inputArg
  ? path.resolve(inputArg)
  : path.join(__dirname, "..", "atlas_inventory.csv");

if (!fs.existsSync(csvPath)) {
  console.error(`\n❌ CSV file not found: ${csvPath}`);
  console.error("   Place your file at ./atlas_inventory.csv or pass a path:");
  console.error("   npm run ingest ./mydata.csv\n");
  process.exit(1);
}

console.log(`\nReading CSV: ${csvPath}`);

// 2. Read and parse the CSV. `columns: true` uses the header row as keys, so
//    each row becomes an object like { account_number: "...", balance: "...", ... }.
const raw = fs.readFileSync(csvPath, "utf8");
const rows = parse(raw, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

// 3. Prepare an "upsert" statement once and reuse it for every row (fast + safe).
//    ON CONFLICT(account_number) means: if a row with this account_number already
//    exists, update it instead of failing.
const upsert = db.prepare(`
  INSERT INTO accounts
    (account_number, debtor_name, phone_number, balance, status, client_name, updated_at)
  VALUES
    (@account_number, @debtor_name, @phone_number, @balance, @status, @client_name, datetime('now'))
  ON CONFLICT(account_number) DO UPDATE SET
    debtor_name  = excluded.debtor_name,
    phone_number = excluded.phone_number,
    balance      = excluded.balance,
    status       = excluded.status,
    client_name  = excluded.client_name,
    updated_at   = datetime('now');
`);

// Helper: does this account_number already exist? (so we can report
// inserts vs. updates separately)
const exists = db.prepare(
  "SELECT 1 FROM accounts WHERE account_number = ?"
);

// 4. Walk every row, validate it, and load the good ones.
const summary = {
  total: rows.length,
  inserted: 0,
  updated: 0,
  skipped: 0,
};
const problems = [];

// Wrapping the loop in a transaction makes the whole load much faster and means
// it either applies cleanly or reports issues per-row.
const runLoad = db.transaction(() => {
  rows.forEach((row, i) => {
    const lineNo = i + 2; // +2 because line 1 is the header, arrays start at 0

    const accountNumber = (row.account_number || "").trim();
    const balanceRaw = (row.balance ?? "").toString().trim();

    // --- Validation rule 1: account_number is required ---
    if (!accountNumber) {
      summary.skipped++;
      problems.push(`Line ${lineNo}: missing account_number -> skipped`);
      return;
    }

    // --- Validation rule 2: balance must be a number ---
    const balance = Number(balanceRaw);
    if (balanceRaw === "" || Number.isNaN(balance)) {
      summary.skipped++;
      problems.push(
        `Line ${lineNo} (account ${accountNumber}): balance "${balanceRaw}" is not numeric -> skipped`
      );
      return;
    }

    // Track whether this is a brand-new account or an overwrite.
    const alreadyThere = exists.get(accountNumber);

    upsert.run({
      account_number: accountNumber,
      debtor_name: row.debtor_name || null,
      phone_number: row.phone_number || null,
      balance: balance,
      status: row.status || null,
      client_name: row.client_name || null,
    });

    if (alreadyThere) summary.updated++;
    else summary.inserted++;
  });
});

runLoad();

// 5. Print a clear, human-readable summary.
console.log("\n===== Ingestion Summary =====");
console.log(`Rows in file : ${summary.total}`);
console.log(`Inserted     : ${summary.inserted}`);
console.log(`Updated      : ${summary.updated}  (duplicate account_numbers overwritten)`);
console.log(`Skipped      : ${summary.skipped}`);

if (problems.length) {
  console.log("\n----- Skipped rows -----");
  problems.forEach((p) => console.log("  - " + p));
}

const totalInDb = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
console.log(`\nTotal accounts now in database: ${totalInDb}`);
console.log("Done.\n");

db.close();
