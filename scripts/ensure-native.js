// scripts/ensure-native.js
// Runs automatically after `npm install` (postinstall).
//
// Why this exists: better-sqlite3 is a native module, so its compiled binary is
// tied to one Node ABI. When a host reuses a cached node_modules, `npm install`
// reports "up to date" and never rebuilds -- so a binary built under an older
// Node survives into a newer one, and the app dies at startup with:
//
//   NODE_MODULE_VERSION 115. This version of Node.js requires 127.
//   code: 'ERR_DLOPEN_FAILED'
//
// So instead of trusting the install, we actually try to load the module. If it
// loads, we do nothing. If it fails, we rebuild it here -- which means the fix
// happens no matter which build command the host is configured to run.

const { execSync } = require("child_process");

function tryLoad() {
  try {
    // require() alone is NOT enough: better-sqlite3 only dlopen()s its native
    // binary when a Database is actually constructed. A broken/mismatched
    // binary passes require() and then throws at `new Database(...)` -- which
    // is exactly where the deploy crashed (src/db.js). So open one for real.
    const Database = require("better-sqlite3");
    const probe = new Database(":memory:");
    probe.exec("CREATE TABLE probe (id INTEGER)");
    probe.close();
    return true;
  } catch {
    return false;
  }
}

if (tryLoad()) {
  console.log(`[ensure-native] better-sqlite3 OK for Node ${process.version} (ABI ${process.versions.modules})`);
  process.exit(0);
}

console.log(
  `[ensure-native] better-sqlite3 will not load under Node ${process.version} ` +
    `(ABI ${process.versions.modules}) -- rebuilding...`
);

try {
  // --build-from-source guarantees a binary for THIS Node, rather than
  // re-fetching a prebuild that may not match.
  execSync("npm rebuild better-sqlite3 --build-from-source", { stdio: "inherit" });
} catch {
  console.error("[ensure-native] rebuild command failed");
}

if (tryLoad()) {
  console.log("[ensure-native] rebuild successful");
} else {
  console.error("[ensure-native] better-sqlite3 STILL will not load -- the server will not start");
  process.exit(1);
}
