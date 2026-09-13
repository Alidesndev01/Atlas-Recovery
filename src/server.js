// src/server.js
// A small HTTP API the AI agent can call to look up an account by its number.
//
// Endpoints:
//   GET /                       -> tiny info page
//   GET /health                 -> { ok: true }  (for uptime checks / deploys)
//   GET /accounts/:accountNumber -> the account as JSON, or 404 if not found
//   GET /accounts?account_number=... -> same thing via query string (both supported)

const express = require("express");
const { db } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Prepared lookup statement (fast, and safe against SQL injection because the
// value is passed as a parameter, never string-concatenated).
const findByAccount = db.prepare(
  "SELECT account_number, debtor_name, phone_number, balance, status, client_name FROM accounts WHERE account_number = ?"
);

// Shared handler used by both the path-style and query-style routes.
function lookupAndRespond(accountNumber, res) {
  if (!accountNumber || !accountNumber.trim()) {
    return res.status(400).json({
      error: "bad_request",
      message: "An account_number is required.",
    });
  }

  const account = findByAccount.get(accountNumber.trim());

  if (!account) {
    return res.status(404).json({
      error: "account_not_found",
      message: `No account found for account_number '${accountNumber}'.`,
      account_number: accountNumber,
    });
  }

  // Return the fields the AI agent needs, in a predictable shape.
  return res.json({
    account_number: account.account_number,
    debtor_name: account.debtor_name,
    phone_number: account.phone_number,
    balance: account.balance,
    status: account.status,
    client_name: account.client_name,
  });
}

// --- Routes ---

app.get("/", (_req, res) => {
  res.json({
    service: "Atlas Recovery Account Lookup API",
    usage: "GET /accounts/:accountNumber  or  GET /accounts?account_number=...",
    health: "GET /health",
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Query-string style: /accounts?account_number=ACC-1001
// (declared before the path route so it isn't swallowed by ':accountNumber')
app.get("/accounts", (req, res) => {
  lookupAndRespond(req.query.account_number, res);
});

// Path style: /accounts/ACC-1001
app.get("/accounts/:accountNumber", (req, res) => {
  lookupAndRespond(req.params.accountNumber, res);
});

app.listen(PORT, () => {
  console.log(`Atlas Recovery lookup API listening on port ${PORT}`);
  console.log(`Try:  http://localhost:${PORT}/accounts/ACC-1001`);
});
