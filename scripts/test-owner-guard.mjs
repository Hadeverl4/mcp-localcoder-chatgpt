import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-guard-test-"));
process.env.OWNER_GUARD_ENABLED = "true";
process.env.OWNER_GUARD_STATE_DIR = tmp;

const { evaluateOwnerGuard, getOwnerGuardStatePath, setOwnerGuardMode } = await import("../dist/lib/owner-guard.js");

function identity() {
  const machine = (process.env.COMPUTERNAME || os.hostname()).trim();
  const user = (process.env.USERNAME || os.userInfo().username).trim();
  let sid = "";
  if (process.platform === "win32") {
    const raw = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim();
    sid = raw.match(/"[^"]+","([^"]+)"/)?.[1]?.trim() || "";
  }
  return { machine, user, sid };
}

function writeState(mode, expiresAt = null, maxIdle = 240) {
  const id = identity();
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    getOwnerGuardStatePath(),
    JSON.stringify({
      version: 1,
      mode,
      machine: id.machine,
      user: id.user,
      sid: id.sid,
      armed_at: mode === "armed" ? new Date().toISOString() : null,
      expires_at: expiresAt,
      max_idle_minutes: maxIdle,
    }),
    "utf8"
  );
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`OK  ${name}`);
    passed++;
  } else {
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

try {
  fs.rmSync(getOwnerGuardStatePath(), { force: true });
  check("missing state fails closed for write", evaluateOwnerGuard("write_file").allowed === false);
  check("missing state still allows agent_status", evaluateOwnerGuard("agent_status").allowed === true);

  writeState("readonly");
  check("readonly allows read_many", evaluateOwnerGuard("read_many").allowed === true);
  check("readonly blocks run_command", evaluateOwnerGuard("run_command").allowed === false);
  check("readonly blocks write_file", evaluateOwnerGuard("write_file").allowed === false);

  writeState("armed", new Date(Date.now() + 60_000).toISOString());
  const armed = evaluateOwnerGuard("run_command");
  check("armed allows run_command", armed.allowed === true, armed.reason);

  writeState("armed", new Date(Date.now() - 60_000).toISOString());
  const expired = evaluateOwnerGuard("run_command");
  check("expired arm blocks run_command", expired.allowed === false);
  check("expired arm demotes to readonly", expired.effective_mode === "readonly", expired.effective_mode);

  const id = identity();
  fs.writeFileSync(
    getOwnerGuardStatePath(),
    JSON.stringify({
      version: 1,
      mode: "armed",
      machine: id.machine + "-OTHER",
      user: id.user,
      sid: id.sid,
      armed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      max_idle_minutes: 240,
    }),
    "utf8"
  );
  const mismatch = evaluateOwnerGuard("write_file");
  check("identity mismatch fails closed", mismatch.allowed === false && mismatch.effective_mode === "locked");

  setOwnerGuardMode("readonly", { idle_minutes: 15 });
  const localReadonly = evaluateOwnerGuard("read_text_file");
  check("local setter writes identity-bound readonly state", localReadonly.allowed === true && localReadonly.mode === "readonly");
  let rejectedInvalid = false;
  try { setOwnerGuardMode("armed", { minutes: Number.NaN, idle_minutes: 10 }); } catch { rejectedInvalid = true; }
  check("local setter rejects invalid TTL", rejectedInvalid);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
