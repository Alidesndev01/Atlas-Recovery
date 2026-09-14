// src/ingest-core.js
// The single source of truth for "how a CSV becomes rows in the database".
//
// Both entry points use this:
//   * src/ingest.js      -> `npm run ingest` (reads a file from disk)
//   * POST /api/upload   -> the web interface (reads an uploaded buffer)
//
// Keeping it in one place means the CLI and the upload endpoint can never drift
// apart on validation rules or duplicate handling.
//
// Rules (also documented in the README):
//   * Duplicate account_number -> OVERWRITE (upsert). Atlas re-uploads their
//     latest inventory periodically, so the newest row wins.
//   * Missing account_number   -> SKIP. Without it we can't identify the account.
//   * Non-numeric balance      -> SKIP and report.
//   * One bad row never aborts the load. Good rows land, bad rows get reported.

const { parse } = require("csv-parse/sync");
const { db } = require("./db");

// The columns the assignment guarantees. We check for these up front so a
// completely wrong file (say, someone uploads their expenses spreadsheet)
// fails loudly instead of silently importing zero rows.
const REQUIRED_COLUMNS = ["account_number", "balance"];

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

const exists = db.prepare("SELECT 1 FROM accounts WHERE account_number = ?");

/**
 * Parse and load a CSV.
 *
 * @param {string|Buffer} csvContent - raw CSV text (from a file or an upload).
 * @returns {{total, inserted, updated, skipped, problems, totalInDb}}
 * @throws {Error} with `.code` set when the file itself is unusable
 *                 (EMPTY_FILE, PARSE_ERROR, MISSING_COLUMNS).
 */
function ingestCsv(csvContent) {
  const text = Buffer.isBuffer(csvContent)
    ? csvContent.toString("utf8")
    : String(csvContent);

  // Strip a UTF-8 BOM. Excel adds one on "Save as CSV", and without this the
  // very first header becomes "﻿account_number" and nothing matches.
  const clean = text.replace(/^﻿/, "");

  if (!clean.trim()) {
    const err = new Error("The file is empty.");
    err.code = "EMPTY_FILE";
    throw err;
  }

  let rows;
  try {
    rows = parse(clean, {
      columns: (header) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true, // a stray extra comma shouldn't kill the import
    });
  } catch (e) {
    const err = new Error(`Could not parse the file as CSV: ${e.message}`);
    err.code = "PARSE_ERROR";
    throw err;
  }

  if (rows.length === 0) {
    const err = new Error("The file has a header row but no data rows.");
    err.code = "EMPTY_FILE";
    throw err;
  }

  // Header check: does this file even look like an inventory export?
  const headers = Object.keys(rows[0]);
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    const err = new Error(
      `The file is missing required column(s): ${missing.join(", ")}. ` +
        `Found: ${headers.join(", ")}`
    );
    err.code = "MISSING_COLUMNS";
    throw err;
  }

  const summary = { total: rows.length, inserted: 0, updated: 0, skipped: 0 };
  const problems = [];

  // Within a single upload the same account_number can appear more than once
  // (the sample file does exactly this). The last occurrence wins, and we count
  // it as one record touched rather than an insert plus an update.
  const seenInThisFile = new Set();

  // One transaction for the whole load: much faster, and the DB is never left
  // half-updated if something unexpected goes wrong mid-file.
  const runLoad = db.transaction(() => {
    rows.forEach((row, i) => {
      const lineNo = i + 2; // line 1 is the header; arrays start at 0

      const accountNumber = (row.account_number || "").trim();
      const balanceRaw = (row.balance ?? "").toString().trim();

      // --- Rule 1: account_number is required ---
      if (!accountNumber) {
        summary.skipped++;
        problems.push(`Line ${lineNo}: missing account_number -> skipped`);
        return;
      }

      // --- Rule 2: balance must be numeric ---
      // Tolerate the formatting real exports contain: "$1,250.75", "(50.00)"
      // for negatives, and stray whitespace.
      const negative = /^\(.*\)$/.test(balanceRaw);
      const normalised = balanceRaw
        .replace(/[$,\s]/g, "")
        .replace(/^\((.*)\)$/, "$1");
      const balance = (negative ? -1 : 1) * Number(normalised);

      if (normalised === "" || Number.isNaN(balance)) {
        summary.skipped++;
        problems.push(
          `Line ${lineNo} (account ${accountNumber}): balance "${balanceRaw}" is not numeric -> skipped`
        );
        return;
      }

      const countedAlready = seenInThisFile.has(accountNumber);
      const alreadyInDb = exists.get(accountNumber);

      upsert.run({
        account_number: accountNumber,
        debtor_name: row.debtor_name || null,
        phone_number: row.phone_number || null,
        balance,
        status: row.status || null,
        client_name: row.client_name || null,
      });

      if (!countedAlready) {
        if (alreadyInDb) summary.updated++;
        else summary.inserted++;
        seenInThisFile.add(accountNumber);
      } else {
        // A repeat of a row we already handled in this same file.
        problems.push(
          `Line ${lineNo} (account ${accountNumber}): duplicate within this file -> later row overwrote the earlier one`
        );
      }
    });
  });

  runLoad();

  const totalInDb = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;

  return { ...summary, problems, totalInDb };
}

module.exports = { ingestCsv };
