# Atlas Recovery — Account Lookup Prototype

A small Node.js service for CollectWise / Atlas Recovery that:

1. **Ingests** a debtor CSV (`atlas_inventory.csv`) into a SQLite database — from the
   command line **or** through a web page where staff can upload the file.
2. **Exposes an HTTP API** so the AI agent can look up an account by `account_number`.

Built to be simple, reliable, and easy to run in one command.

---

## Tech stack

- **Node.js 20+**
- **SQLite** via `better-sqlite3` — a single-file database, no separate DB server
- **Express 5** for the HTTP API
- **csv-parse** for reading the CSV
- **multer** for handling the file upload

SQLite was chosen deliberately: for a periodically-uploaded inventory file and simple
account lookups, it's fast, zero-config, and keeps the whole prototype in one folder.
The same code moves to Postgres later with minimal changes if volume grows.

---

## Setup

```bash
npm install
```

---

## Quick start

```bash
npm run ingest   # load the sample CSV into the database
npm start        # start the API + upload interface on http://localhost:3000
```

Then open **http://localhost:3000** in a browser.

---

## 1. Ingesting the CSV

There are two ways to load data. Both run the **exact same** parsing, validation and
duplicate-handling code (`src/ingest-core.js`), so they always behave identically.

### Option A — the web interface (for Atlas staff)

Start the server and open `http://localhost:3000`. Drag the CSV onto the page (or click
to browse) and press **Upload & import**. You get an immediate summary of how many rows
were inserted, updated and skipped — and exactly why each skipped row was rejected.

The same page has a lookup box so you can verify an account straight after uploading.

### Option B — the command line

```bash
npm run ingest                     # reads ./atlas_inventory.csv
npm run ingest ./path/to/file.csv  # or point it at any file
```

Example output:

```
===== Ingestion Summary =====
Rows in file : 9
Inserted     : 6
Updated      : 0  (duplicate account_numbers overwritten)
Skipped      : 2

----- Notes -----
  - Line 7 (account ACC-1002): duplicate within this file -> later row overwrote the earlier one
  - Line 8 (account ACC-1006): balance "not-a-number" is not numeric -> skipped
  - Line 9: missing account_number -> skipped

Total accounts now in database: 6
```

The database is written to `atlas.db` in the project root.

---

## 2. The API

### Look up an account

```bash
curl http://localhost:3000/accounts/ACC-1001
curl "http://localhost:3000/accounts?account_number=ACC-1001"
```

**200 OK**

```json
{
  "account_number": "ACC-1001",
  "debtor_name": "Jane Doe",
  "phone_number": "+1-555-0100",
  "balance": 1250.75,
  "status": "Active",
  "client_name": "Midwest Credit Union"
}
```

**404 Not Found**

```json
{
  "error": "account_not_found",
  "message": "No account found for account_number 'NOPE'.",
  "account_number": "NOPE"
}
```

**400 Bad Request** — returned when the parameter is empty or still contains an
unrendered `{{template}}` placeholder from the agent config. This is deliberately
*not* a 404: it tells you the agent is misconfigured rather than that the account
is missing.

### Upload a CSV

```bash
curl -X POST -F "file=@atlas_inventory.csv" http://localhost:3000/api/upload
```

```json
{
  "ok": true,
  "filename": "atlas_inventory.csv",
  "total": 9,
  "inserted": 6,
  "updated": 0,
  "skipped": 2,
  "problems": ["Line 9: missing account_number -> skipped"],
  "totalInDb": 6
}
```

Rejected uploads return HTTP 400 with a plain-English `message`:
`no_file`, `invalid_file` (not a `.csv`), `file_too_large` (over 5 MB),
`empty_file`, `missing_columns`, `parse_error`.

### Other endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/` | Upload + lookup interface |
| `GET`  | `/accounts/:accountNumber` | Look up one account |
| `GET`  | `/accounts?account_number=` | Same, query-string style |
| `POST` | `/api/upload` | Upload a CSV (multipart, field name `file`) |
| `GET`  | `/api/stats` | Row count + last upload time |
| `GET`  | `/health` | Liveness check |

---

## Database schema

Table: `accounts`

| Column          | Type | Notes                                              |
|-----------------|------|----------------------------------------------------|
| account_number  | TEXT | **Primary key** — unique per account                |
| debtor_name     | TEXT |                                                     |
| phone_number    | TEXT |                                                     |
| balance         | REAL | Numeric                                             |
| status          | TEXT | e.g. Active, Closed, Settlement Eligible            |
| client_name     | TEXT |                                                     |
| updated_at      | TEXT | Timestamp of the last upload that touched this row  |

`account_number` being the primary key is what enforces uniqueness — SQLite will not
allow two rows to share one.

---

## Design decisions & edge cases

**Duplicate `account_number` → overwrite (upsert).**
Atlas re-uploads their latest inventory periodically, so the newest row should win. On a
duplicate the existing record is updated in place and `updated_at` is refreshed.
(Alternatives would be "skip" or "error"; overwrite matches the real-world workflow of a
refreshed export replacing stale data.) This applies both *across* uploads and *within* a
single file — if the same account appears twice in one CSV, the later row wins and the
summary says so.

**Missing `account_number` → skip and report.**
Without it we can't identify or look up the record.

**Non-numeric `balance` → skip and report.**
Values like `"not-a-number"` never reach the database. Real-world formatting *is*
accepted though: `$1,250.75` parses as `1250.75`, and `(75.50)` — the accounting
convention for a negative — parses as `-75.50`.

**One bad row never stops the load.**
Every row is validated independently inside a single transaction. Good rows land, bad
rows are reported line-by-line so a human can fix the source file.

**Files that aren't really inventory exports are rejected outright.**
If `account_number` or `balance` is missing from the header, the upload fails with a
clear message instead of silently importing zero rows. Uploads are also capped at 5 MB
and restricted to `.csv`.

**Messy-but-valid files are handled.** UTF-8 BOM (what Excel writes on "Save as CSV"),
CRLF line endings, and header capitalisation/whitespace differences are all normalised,
so `Account_Number` works the same as `account_number`.

**Account lookup is tolerant, but never ambiguous.**
The voice agent transcribes spoken account numbers inconsistently — `acc 1001`,
`ACC1001` and `acc-1001` all resolve to `ACC-1001`, because matching happens on a
normalised form (uppercased, punctuation stripped). It is still an **equality** match,
never a partial/`LIKE` one: looking up `1001` returns a 404 rather than guessing. On a
live collections call, quietly returning a different debtor's balance would be far worse
than admitting the account wasn't found.

The included `atlas_inventory.csv` intentionally contains one duplicate, one row with a
missing account number, and one row with a bad balance, so all of this handling is
visible on the very first run.

`test_ali.csv` is the opposite: three clean records (`ACC-3001`–`ACC-3003`) with no
edge cases, for a quick end-to-end check or a demo where you just want every row to
load successfully.

---

## Deployment (Render)

The service is deployed as a Render **Web Service**:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Health check path:** `/health`

`render.yaml` is committed, but note that for a service originally created through the
dashboard, Render keeps using the dashboard's build/start commands and ignores the YAML
unless the service is connected as a Blueprint. The code therefore does not rely on
either command being correct:

**`postinstall` guards the native module.** `better-sqlite3` compiles against one Node
ABI. When a host reuses a cached `node_modules`, `npm install` prints "up to date" and
skips the rebuild, leaving a binary from an older Node -- which crashes at startup with
`NODE_MODULE_VERSION ... ERR_DLOPEN_FAILED`. `scripts/ensure-native.js` runs after every
install, actually opens a database (a plain `require()` is not enough -- the binary is
only loaded when a `Database` is constructed), and rebuilds if that fails.

**Ingestion can never block startup.** A seeded `atlas.db` is committed, so the service
boots with data regardless. If the start command chains `npm run ingest && npm start`, a
missing or malformed CSV now warns and exits 0 rather than taking the API down with it.
Run `npm run ingest` in a terminal and real failures still exit 1, or set
`INGEST_STRICT=1` to force that behaviour.

Render sets `PORT` automatically and the server reads it, so no extra config is needed.

**The Node version is pinned to 22** (`.node-version` and `engines` in `package.json`).
This matters: `better-sqlite3` is a native module and only ships prebuilt binaries for
specific Node ABI versions. On a newer Node the install falls back to compiling from
source, and if that fails the server crashes at startup with
`ERR_DLOPEN_FAILED / NODE_MODULE_VERSION`. Don't loosen this pin without checking that
a prebuild exists for the Node version you move to.

### ⚠️ Important: data does not persist on Render's free tier

Render's free tier gives each instance an **ephemeral filesystem**. `atlas.db` is wiped
whenever the service redeploys or spins down after idling (~15 minutes). A CSV uploaded
through the web interface will work immediately, then disappear after the next restart.

To keep this predictable, a pre-populated `atlas.db` is committed to the repo, so the
deployed service always starts with the sample accounts loaded and the lookup endpoint
always answers.

**Before a live demo, re-upload the CSV through `/` to be sure the data is fresh.**

For production this needs durable storage — either a Render **persistent disk** (paid
plan; then set `DB_PATH=/var/data/atlas.db`) or a hosted Postgres. The `DB_PATH`
environment variable already exists for exactly this, so the change is a config swap
rather than a rewrite.

---

## Project structure

```
atlas-recovery-lookup/
├── package.json
├── atlas_inventory.csv           # sample data (includes edge cases)
├── test_ali.csv                  # small clean 3-record file for quick testing
├── atlas.db                      # committed, pre-populated (see deployment note)
├── README.md
├── customer_issue_resolution_email.md
├── public/
│   └── index.html                # upload + lookup interface
└── src/
    ├── db.js                     # opens SQLite + defines the schema
    ├── init-db.js                # `npm run init-db` — create DB/table explicitly
    ├── ingest-core.js            # shared parse/validate/upsert logic
    ├── ingest.js                 # `npm run ingest` — CLI loader
    └── server.js                 # `npm start` — API + upload endpoint
```
