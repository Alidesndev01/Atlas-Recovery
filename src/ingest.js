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

if (!fs.existsSync(csvPath)) {
  console.error(`\n❌ CSV file not found: ${csvPath}`);
  console.error("   Place your file at ./atlas_inventory.csv or pass a path:");
  console.error("   npm run ingest ./mydata.csv\n");
  process.exit(1);
}

console.log(`\nReading CSV: ${csvPath}`);

let result;
try {
  result = ingestCsv(fs.readFileSync(csvPath));
} catch (e) {
  console.error(`\n❌ Could not ingest this file: ${e.message}\n`);
  db.close();
  process.exit(1);
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
