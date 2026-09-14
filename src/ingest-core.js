// src/ingest-core.js
// The single source of truth for "how an uploaded file becomes rows in the database".
//
// Two file formats are accepted, CSV and Excel (.xlsx/.xls). They differ only in
// how the raw bytes become row objects; from that point on they run through
// exactly the same validation, duplicate handling and upsert, so the two
// formats can never drift apart in behaviour.
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
const ExcelJS = require("exceljs");
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
 * Is this buffer an Excel workbook?
 *
 * We sniff the bytes rather than trust the filename, because a file named
 * .csv can really be a workbook (and vice versa). .xlsx is a ZIP container so
 * it starts with "PK"; .xls is the older OLE2 format with a fixed 8-byte
 * signature.
 */
function looksLikeExcel(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return false;
  const xlsx = buf[0] === 0x50 && buf[1] === 0x4b; // "PK" -> zip -> .xlsx
  const ole2 =
    buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0; // .xls
  return xlsx || ole2;
}

/**
 * Turn a worksheet into the same array-of-objects shape csv-parse produces,
 * so everything downstream is format-agnostic.
 */
function rowsFromWorksheet(sheet) {
  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cellText(cell) ?? "").trim().toLowerCase();
  });

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    let hasAnyValue = false;

    headers.forEach((name, col) => {
      if (!name) return;
      const text = cellText(row.getCell(col));
      if (text !== "" && text != null) hasAnyValue = true;
      obj[name] = text;
    });

    // Spreadsheets are full of trailing blank rows; skip them silently rather
    // than reporting each one as a validation failure.
    if (hasAnyValue) rows.push(obj);
  }
  return rows;
}

/**
 * Read one cell as plain text.
 *
 * Spreadsheet cells are not just strings: a phone number may be stored as a
 * number, a balance may be a formula, and a cell may hold rich text. We
 * normalise all of that to the string form the CSV path would have produced.
 */
function cellText(cell) {
  if (!cell) return "";
  const v = cell.value;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Date) return v.toISOString();
  // Formula cells carry both the formula and its computed result; we want the result.
  if (typeof v === "object") {
    if ("result" in v) return v.result == null ? "" : String(v.result);
    if ("text" in v) return String(v.text);
    if ("richText" in v && Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text).join("");
    }
    if ("hyperlink" in v) return String(v.text ?? v.hyperlink ?? "");
  }
  return String(v);
}

/**
 * Parse and load an uploaded file (CSV or Excel).
 *
 * @param {string|Buffer} content - raw file bytes (from disk or an upload).
 * @returns {Promise<{total, inserted, updated, skipped, problems, totalInDb, format}>}
 * @throws {Error} with `.code` set when the file itself is unusable
 *                 (EMPTY_FILE, PARSE_ERROR, MISSING_COLUMNS).
 */
async function ingestFile(content) {
  if (looksLikeExcel(content)) {
    return loadRows(await parseExcel(content), "excel");
  }
  return loadRows(parseCsv(content), "csv");
}

/**
 * Excel -> row objects.
 */
async function parseExcel(buf) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf);
  } catch (e) {
    const err = new Error(
      `Could not read that Excel file: ${e.message}. ` +
        "If it is an older .xls file, re-save it as .xlsx or CSV."
    );
    err.code = "PARSE_ERROR";
    throw err;
  }

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount === 0) {
    const err = new Error("That workbook has no sheets with any data in them.");
    err.code = "EMPTY_FILE";
    throw err;
  }
  return rowsFromWorksheet(sheet);
}

/**
 * CSV -> row objects.
 */
function parseCsv(csvContent) {
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

  // A file named .xlsx that is not a real workbook lands here, because format
  // is decided by the bytes, not the name. Saying "no data rows" would be
  // confusing, so name the real problem: it has no delimiter anywhere.
  const firstLine = clean.split(/\r?\n/)[0] || "";
  if (!firstLine.includes(",") && !firstLine.includes(";") && !firstLine.includes("\t")) {
    const err = new Error(
      "This does not look like a CSV or Excel file: no column separators were found " +
        "in the first line. If it is a spreadsheet, re-save it as .xlsx or CSV."
    );
    err.code = "PARSE_ERROR";
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

  return rows;
}

/**
 * Validate and load row objects, whatever format they came from.
 *
 * Everything past parsing lives here, so CSV and Excel uploads are held to
 * identical rules.
 */
function loadRows(rows, format) {
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
      // Row 1 is the header and arrays start at 0, so +2 gives the number the
      // user actually sees -- a line number in CSV, a row number in Excel.
      const lineNo = i + 2;
      const where = format === "excel" ? `Row ${lineNo}` : `Line ${lineNo}`;

      const accountNumber = (row.account_number || "").trim();
      const balanceRaw = (row.balance ?? "").toString().trim();

      // --- Rule 1: account_number is required ---
      if (!accountNumber) {
        summary.skipped++;
        problems.push(`${where}: missing account_number -> skipped`);
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
          `${where} (account ${accountNumber}): balance "${balanceRaw}" is not numeric -> skipped`
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
          `${where} (account ${accountNumber}): duplicate within this file -> later row overwrote the earlier one`
        );
      }
    });
  });

  runLoad();

  const totalInDb = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;

  return { ...summary, problems, totalInDb, format };
}

module.exports = {
  ingestFile,
  // Backwards-compatible alias: the original CSV-only entry point.
  ingestCsv: ingestFile,
};
