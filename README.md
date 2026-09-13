# Atlas Recovery — Account Lookup Prototype

A small Node.js service for CollectWise / Atlas Recovery that:

1. **Ingests** a debtor CSV (`atlas_inventory.csv`) into a SQLite database.
2. **Exposes an HTTP API** so the AI agent can look up an account by `account_number`.

Built to be simple, reliable, and easy to run in one command.

---

## Tech stack

- **Node.js** (works on Node 18+)
- **SQLite** via `better-sqlite3` — a single-file database, no separate DB server to install
- **Express** for the HTTP API
- **csv-parse** for reading the CSV

SQLite was chosen deliberately: for a periodically-uploaded inventory file and simple
account lookups, it's fast, zero-config, and keeps the whole prototype in one folder.
The same code moves to Postgres later with minimal changes if volume grows.

---

## Setup

```bash
npm install
```

This also compiles `better-sqlite3` for your machine (needs a normal build toolchain,
which almost every system already has).

---

## 1. Ingest the CSV

Place your file at the project root as `atlas_inventory.csv` (a sample is already
included), then run:

```bash
npm run ingest
```

Or point it at any file:

```bash
npm run ingest ./path/to/some_file.csv
```

You'll get a summary like:

```
===== Ingestion Summary =====
Rows in file : 9
Inserted     : 6
Updated      : 1  (duplicate account_numbers overwritten)
Skipped      : 2

----- Skipped rows -----
  - Line 8 (account ACC-1006): balance "not-a-number" is not numeric -> skipped
  - Line 9: missing account_number -> skipped
```

The database is written to `atlas.db` in the project root.

---

## 2. Run the API

```bash
npm start
```

Then, in another terminal:

```bash
# Look up a valid account (path style)
curl http://localhost:3000/accounts/ACC-1001

# Same thing, query-string style
curl "http://localhost:3000/accounts?account_number=ACC-1001"

# A missing account returns HTTP 404
curl -i http://localhost:3000/accounts/NOPE
```

Successful response:

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

Not-found response (HTTP 404):

```json
{
  "error": "account_not_found",
  "message": "No account found for account_number 'NOPE'.",
  "account_number": "NOPE"
}
```

---

## Database schema

Table: `accounts`

| Column          | Type | Notes                                  |
|-----------------|------|----------------------------------------|
| account_number  | TEXT | **Primary key** — unique per account   |
| debtor_name     | TEXT |                                        |
| phone_number    | TEXT |                                        |
| balance         | REAL | Numeric                                |
| status          | TEXT | e.g. Active, Closed, Settlement Eligible |
| client_name     | TEXT |                                        |
| updated_at      | TEXT | Timestamp of the last upload that touched this row |

---

## Design decisions & edge cases

**Duplicate `account_number` → overwrite (upsert).**
Atlas re-uploads their latest inventory periodically, so the newest row should win.
On a duplicate, the existing record is updated in place and `updated_at` is refreshed.
(Alternatives would be "skip" or "error"; overwrite matches the real-world workflow
of a refreshed export replacing stale data.)

**Missing `account_number` → skip.**
Without an account number we can't identify or look up the record, so the row is
skipped and reported. We never crash the whole import over one bad row.

**Non-numeric `balance` → skip + report.**
A balance like `"not-a-number"` is rejected so bad data never lands in the DB.
The row is listed in the summary so a human can fix the source file.

**One bad row never stops the load.**
Every row is validated independently; good rows load, bad rows are reported.

The included `atlas_inventory.csv` intentionally contains one duplicate, one row
with a missing account number, and one row with a bad balance, so you can see all
of this handling in action on the first run.

---

## Deploying so you have a public URL

Two easy options.

### Option A — Render (free, gives a permanent public URL)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a new **Web Service** from that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. After it deploys, Render gives you a URL like `https://atlas-recovery.onrender.com`.
5. Ingest data on the server the first time by adding a one-off command, or commit
   `atlas.db` (already populated locally) so it ships with the app. Simplest for a
   demo: run `npm run ingest` locally, then commit `atlas.db`.

Test it:

```
https://YOUR-APP.onrender.com/accounts/ACC-1001
```

### Option B — ngrok (fastest, temporary URL for a live demo)

Keep the server running locally (`npm start`) and in another terminal:

```bash
npx ngrok http 3000
```

ngrok prints a public `https://...` URL that forwards straight to your local API.
Great for a quick call/demo; the URL goes away when you stop ngrok.

---

## Project structure

```
atlas-recovery-lookup/
├── package.json
├── atlas_inventory.csv      # sample data (includes edge cases)
├── README.md
├── src/
│   ├── db.js                # opens SQLite + defines the schema
│   ├── init-db.js           # `npm run init-db` — create DB/table explicitly
│   ├── ingest.js            # `npm run ingest` — load the CSV
│   └── server.js            # `npm start` — the lookup API
└── atlas.db                 # created after you run ingest
```
