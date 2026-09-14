// src/server.js
const express = require("express");
const { db } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const findByAccount = db.prepare(`
  SELECT account_number, debtor_name, phone_number, balance, status, client_name 
  FROM accounts 
  WHERE account_number = ? 
     OR account_number = ?
     OR account_number LIKE ?
  LIMIT 1
`);

function lookupAndRespond(rawInput, res) {
  const target = (rawInput || "").trim();

  // If nothing was passed or unparsed template was sent, return a bad request error
  if (!target || target === "{{account_number}}" || target.includes("{{")) {
    return res.status(400).json({
      error: "bad_request",
      message: "A valid account_number parameter is required.",
    });
  }

  const cleaned = target.toUpperCase().replace(/\s+/g, "");
  const withDash = cleaned.startsWith("ACC") && !cleaned.startsWith("ACC-") 
    ? cleaned.replace("ACC", "ACC-") 
    : cleaned;
  const digitsOnly = cleaned.replace(/\D/g, "");

  const account = findByAccount.get(
    target,
    withDash,
    `%${digitsOnly || cleaned}%`
  );

  if (!account) {
    return res.status(404).json({
      error: "account_not_found",
      message: `No account found for '${target}'.`,
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

app.get("/", (_req, res) => {
  res.json({ service: "Atlas Recovery Account Lookup API" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/accounts", (req, res) => {
  lookupAndRespond(req.query.account_number, res);
});

app.get("/accounts/:accountNumber", (req, res) => {
  lookupAndRespond(req.params.accountNumber, res);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});