import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureToken = "test-only-" + randomBytes(24).toString("hex");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await freePort();
let adminPort = await freePort();
while (adminPort === port) adminPort = await freePort();

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    MCP_TOKEN: fixtureToken,
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    HOST: "127.0.0.1",
    WORKSPACE_PATH: root,
    EXTRA_WORKSPACE_PATHS: "",
    WORKSPACE_PATHS: "",
    ALLOWED_WORKSPACE_PATHS: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    logs = (logs + String(chunk)).slice(-262144);
  });
}

try {
  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("test MCP child exited before health was available");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert.ok(health, "test MCP health must become reachable");
  assert.deepEqual(health, { status: "ok", name: "codex-mcp-server" });
  assert.ok(!JSON.stringify(health).includes(fixtureToken), "health must not reveal a token");

  const authorized = await fetch(`http://127.0.0.1:${port}/mcp/${fixtureToken}`);
  assert.equal(authorized.status, 400, "token-protected MCP path must remain functional");
  const unknown = await fetch(`http://127.0.0.1:${port}/unknown/${fixtureToken}`);
  assert.equal(unknown.status, 404, "unknown paths must not be accessible");
  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.ok(!logs.includes(fixtureToken), "startup/request logs must never print the token");
  assert.ok(logs.includes("[redacted]"), "authenticated MCP request path must be redacted");
  console.log("health-token-redaction: PASS (minimal health, auth route, redacted logs)");
} finally {
  child.kill("SIGTERM");
}
