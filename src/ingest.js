// src/ingest.js
// CLI entry point: reads a CSV file from disk and loads it into the database.
//
// Usage:
//   npm run ingest                     -> reads ./atlas_inventory.csv
//   npm run ingest ./path/to/file.csv  -> reads a specific file
//
// All parsing, validation and duplicate handling lives in ./ingest-core.js,
// which the upload endpoint uses too, so both paths behave identically.

const fs = require("fs");
const path = require("path");
const { ingestCsv } = require("./ingest-core");
const { db } = require("./db");

const inputArg = process.argv[2];
const csvPath = inputArg
  ? path.resolve(inputArg)
  : path.join(__dirname, "..", "atlas_inventory.csv");

// When ingest runs as part of a deploy's start command (e.g.
// `npm run ingest && npm start`), exiting non-zero would stop the server from
// ever starting. A missing or bad CSV is not a reason to take the API down --
// the committed atlas.db already holds data -- so in that case we warn and exit
// 0. Run it directly (`npm run ingest`) and a real failure still exits 1.
const STRICT = process.stdout.isTTY || process.env.INGEST_STRICT === "1";

function bail(msg) {
  console.error(msg);
  if (STRICT) process.exit(1);
  console.error("   Continuing anyway so the server can still start.\n");
  process.exit(0);
}

if (!fs.existsSync(csvPath)) {
  bail(
    `\n⚠️  CSV file not found: ${csvPath}\n` +
      "   Place your file at ./atlas_inventory.csv or pass a path:\n" +
      "   npm run ingest ./mydata.csv\n"
  );
}

console.log(`\nReading CSV: ${csvPath}`);

let result;
try {
  result = ingestCsv(fs.readFileSync(csvPath));
} catch (e) {
  db.close();
  bail(`\n⚠️  Could not ingest this file: ${e.message}\n`);
}

console.log("\n===== Ingestion Summary =====");
console.log(`Rows in file : ${result.total}`);
console.log(`Inserted     : ${result.inserted}`);
console.log(`Updated      : ${result.updated}  (duplicate account_numbers overwritten)`);
console.log(`Skipped      : ${result.skipped}`);

if (result.problems.length) {
  console.log("\n----- Notes -----");
  result.problems.forEach((p) => console.log("  - " + p));
}

console.log(`\nTotal accounts now in database: ${result.totalInDb}`);
console.log("Done.\n");

db.close();
