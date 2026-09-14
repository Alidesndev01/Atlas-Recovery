// scripts/ensure-native.js
// Runs automatically after `npm install` (postinstall).
//
// Why this exists: better-sqlite3 is a native module, so its compiled binary is
// tied to one Node ABI. When a host reuses a cached node_modules, `npm install`
// reports "up to date" and never rebuilds -- so a binary built under an older
// Node survives into a newer one and the app dies at startup with:
//
//   NODE_MODULE_VERSION 115. This version of Node.js requires 127.
//   code: 'ERR_DLOPEN_FAILED'
//
// Rather than trust the install, we actually open a database. If that works we
// do nothing. If it fails we repair it, so the fix holds no matter which build
// command the host is configured to run.

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PKG_DIR = path.join(__dirname, "..", "node_modules", "better-sqlite3");

function works() {
  try {
    // require() alone is NOT enough: better-sqlite3 only dlopen()s its native
    // binary when a Database is constructed. A stale binary passes require()
    // and then throws at `new Database(...)` -- exactly where the deploy
    // crashed (src/db.js). So construct one for real.
    delete require.cache[require.resolve("better-sqlite3")];
    const Database = require("better-sqlite3");
    const probe = new Database(":memory:");
    probe.exec("CREATE TABLE probe (id INTEGER)");
    probe.close();
    return true;
  } catch (e) {
    return false;
  }
}

function run(label, cmd, cwd) {
  console.log(`[ensure-native] ${label}: ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: cwd || process.cwd() });
    return true;
  } catch {
    console.log(`[ensure-native] ${label} did not complete`);
    return false;
  }
}

const node = `${process.version} (ABI ${process.versions.modules})`;

if (works()) {
  console.log(`[ensure-native] better-sqlite3 OK for Node ${node}`);
  process.exit(0);
}

console.log(`[ensure-native] better-sqlite3 will not load under Node ${node} -- repairing`);

if (!fs.existsSync(PKG_DIR)) {
  console.error(`[ensure-native] ${PKG_DIR} does not exist; cannot repair`);
  process.exit(1);
}

// Strategy 1: fetch the prebuilt binary for THIS exact Node ABI.
// `npm rebuild --build-from-source` is NOT used: npm does not recognise that
// flag (it warns "Unknown cli config"), silently ignores it, and can report
// "rebuilt dependencies successfully" without having compiled anything.
if (
  run("prebuild-install", "npx --no-install prebuild-install --force --tag-prefix v", PKG_DIR) &&
  works()
) {
  console.log("[ensure-native] repaired via prebuild-install");
  process.exit(0);
}

// Strategy 2: compile from source. This is what better-sqlite3's own install
// script falls back to (`prebuild-install || node-gyp rebuild --release`).
if (run("build from source", "npm run build-release", PKG_DIR) && works()) {
  console.log("[ensure-native] repaired by compiling from source");
  process.exit(0);
}

// Strategy 3: delete the package and reinstall it outright.
if (
  run("reinstall", `rm -rf "${PKG_DIR}" && npm install better-sqlite3 --no-save --ignore-scripts=false`) &&
  works()
) {
  console.log("[ensure-native] repaired by reinstalling");
  process.exit(0);
}

console.error(
  `[ensure-native] could not produce a working better-sqlite3 for Node ${node}.\n` +
    "[ensure-native] The server will not start. Check that the Node version is one\n" +
    "[ensure-native] better-sqlite3 publishes a prebuild for, or that a C++ toolchain exists."
);
process.exit(1);
