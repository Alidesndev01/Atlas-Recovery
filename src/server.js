// src/server.js
// The HTTP API the AI agent calls, plus a small web interface for Atlas staff
// to upload their inventory CSV.
//
// Endpoints:
//   GET  /                         -> upload + lookup interface
//   GET  /health                   -> liveness check
//   GET  /accounts/:accountNumber  -> look up one account
//   GET  /accounts?account_number= -> same, query-string style
//   POST /api/upload               -> upload a CSV (multipart, field name "file")
//   GET  /api/stats                -> row count + last upload time

const path = require("path");
const express = require("express");
const multer = require("multer");
const { db } = require("./db");
const { ingestFile } = require("./ingest-core");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------

// Files are held in memory and parsed straight from the buffer — nothing is
// written to disk. 5 MB is far more than an inventory export needs and keeps a
// huge file from exhausting memory on a small dyno.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    // Browsers report these types inconsistently (text/csv,
    // application/vnd.ms-excel, sometimes octet-stream), so the extension is
    // the reliable signal. The actual format is sniffed from the bytes later.
    const ok = [".csv", ".txt", ".xlsx", ".xls"].some((ext) => name.endsWith(ext));
    if (ok) return cb(null, true);
    cb(
      Object.assign(new Error("Only CSV and Excel (.xlsx, .xls) files are accepted."), {
        code: "BAD_FILE_TYPE",
      })
    );
  },
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const tooBig = uploadErr.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        ok: false,
        error: tooBig ? "file_too_large" : "invalid_file",
        message: tooBig
          ? "That file is larger than the 5 MB limit."
          : uploadErr.message,
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "no_file",
        message: "No file was uploaded. Choose a CSV or Excel file and try again.",
      });
    }

    try {
      // Parsing Excel is async, so the whole handler awaits the result.
      const result = await ingestFile(req.file.buffer);
      return res.json({
        ok: true,
        filename: req.file.originalname,
        ...result,
      });
    } catch (e) {
      // Thrown by ingestCsv when the file itself is unusable.
      const known = ["EMPTY_FILE", "PARSE_ERROR", "MISSING_COLUMNS"];
      if (known.includes(e.code)) {
        return res.status(400).json({
          ok: false,
          error: e.code.toLowerCase(),
          message: e.message,
        });
      }
      console.error("Upload failed:", e);
      return res.status(500).json({
        ok: false,
        error: "ingest_failed",
        message: "Something went wrong while importing the file.",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Account lookup
// ---------------------------------------------------------------------------

const findExact = db.prepare(`
  SELECT account_number, debtor_name, phone_number, balance, status, client_name
  FROM accounts
  WHERE account_number = ?
  LIMIT 1
`);

// Fallback for the voice agent: callers say "A C C one zero zero one" and the
// transcription arrives as "acc 1001", "ACC1001", "acc-1001" etc. We compare
// on a normalised form (uppercase, non-alphanumerics stripped) so those all
// resolve — but it stays an EQUALITY match, never a partial/LIKE one. A
// substring search would let "1001" quietly return a different debtor's
// balance, which is the kind of error that must never reach a live call.
const findNormalised = db.prepare(`
  SELECT account_number, debtor_name, phone_number, balance, status, client_name
  FROM accounts
  WHERE UPPER(REPLACE(REPLACE(REPLACE(account_number, '-', ''), ' ', ''), '_', '')) = ?
  LIMIT 1
`);

function lookupAndRespond(rawInput, res) {
  const target = (rawInput || "").trim();

  // Guard against an unrendered template variable reaching us from the agent
  // config — without this it would 404 and look like a missing account.
  if (!target || target.includes("{{")) {
    return res.status(400).json({
      error: "bad_request",
      message: "A valid account_number parameter is required.",
    });
  }

  const normalised = target.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const account = findExact.get(target) || findNormalised.get(normalised);

  if (!account) {
    return res.status(404).json({
      error: "account_not_found",
      message: `No account found for account_number '${target}'.`,
      account_number: target,
    });
  }

  return res.json({
    account_number: account.account_number,
    debtor_name: account.debtor_name,
    phone_number: account.phone_number,
    balance: account.balance,
    status: account.status,
    client_name: account.client_name,
  });
}

app.get("/accounts", (req, res) => lookupAndRespond(req.query.account_number, res));
app.get("/accounts/:accountNumber", (req, res) =>
  lookupAndRespond(req.params.accountNumber, res)
);

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

app.get("/api/stats", (_req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM accounts").get();
  const last = db
    .prepare("SELECT MAX(updated_at) AS t FROM accounts")
    .get().t;
  res.json({ total_accounts: n, last_updated: last });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
