// src/init-db.js
// Optional helper: run `npm run init-db` to create the database file and the
// table without ingesting anything. (Ingestion also creates them automatically,
// so this is mainly here to make the schema step explicit for reviewers.)

const { db, DB_PATH } = require("./db");

console.log(`Database ready at: ${DB_PATH}`);
console.log("Table 'accounts' is in place. You can now run: npm run ingest");

db.close();
