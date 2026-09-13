// src/db.js
// Central place that opens the SQLite database and makes sure the
// `accounts` table exists. Every other file imports the connection from here
// so we only ever have one definition of the schema.

const path = require("path");
const Database = require("better-sqlite3");

// The database is a single file on disk. If it doesn't exist yet, SQLite
// creates it automatically the first time we connect.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "atlas.db");

const db = new Database(DB_PATH);

// WAL mode = better performance and lets reads happen while a write is going on.
db.pragma("journal_mode = WAL");

// The schema. account_number is the PRIMARY KEY, which enforces that it is
// unique — SQLite will not let two rows share the same account_number.
// updated_at lets us see when a record was last touched by an upload.
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    account_number TEXT PRIMARY KEY,
    debtor_name    TEXT,
    phone_number   TEXT,
    balance        REAL,
    status         TEXT,
    client_name    TEXT,
    updated_at     TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = { db, DB_PATH };
