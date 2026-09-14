// src/server.js
const express = require("express");
const { db } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

// Checks exact match OR matches digits/suffix (e.g. '1001' matches 'ACC-1001')
const findByAccount = db.prepare(`
  SELECT account_number, debtor_name, phone_number, balance, status, client_name 
  FROM accounts 
  WHERE account_number = ? 
     OR account_number = ?
     OR account_number LIKE ?
  LIMIT 1
`);

function lookupAndRespond(rawInput, res) {
  if (!rawInput || !rawInput.trim()) {
    return res.status(400).json({
      error: "bad_request",
      message: "An account_number is required.",
    });
  }

  const cleaned = rawInput.trim().toUpperCase().replace(/\s+/g, ""); // "A C C 1001" -> "ACC1001"
  const formattedWithDash = cleaned.startsWith("ACC") && !cleaned.startsWith("ACC-") 
    ? cleaned.replace("ACC", "ACC-") 
    : cleaned; // "ACC1001" -> "ACC-1001"
  const digitsOnly = cleaned.replace(/\D/g, ""); // "1001"

  const account = findByAccount.get(
    rawInput.trim(),
    formattedWithDash,
    `%${digitsOnly || cleaned}%`
  );

  if (!account) {
    return res.status(404).json({
      error: "account_not_found",
      message: `No account found for '${rawInput}'.`,
      account_number: rawInput,
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

app.get("/", (_req, res) => {
  res.json({
    service: "Atlas Recovery Account Lookup API",
    usage: "GET /accounts/:accountNumber or GET /accounts?account_number=...",
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/accounts", (req, res) => {
  lookupAndRespond(req.query.account_number, res);
});

app.get("/accounts/:accountNumber", (req, res) => {
  lookupAndRespond(req.params.accountNumber, res);
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});