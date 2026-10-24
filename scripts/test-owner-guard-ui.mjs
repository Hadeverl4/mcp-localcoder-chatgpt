import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Run the real Owner Guard UI handlers with a mocked DOM and API.
// Never change the actual local Owner Guard state during this test.
const source = fs.readFileSync(path.resolve("public/ui/app.js"), "utf8");
const begin = source.indexOf("function formatDuration(");
const end = source.indexOf("function startOwnerGuardUiTimers(");
assert(begin >= 0 && end > begin, "Owner Guard UI functions must be present");

const elements = new Map();
function element(id, initial = "") {
  const classes = new Set();
  const object = {
    id, value: initial, textContent: "", className: "", disabled: false, title: "",
    dataset: {}, classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
  };
  elements.set(id, object);
  return object;
}

for (const id of [
  "owner-guard-badge", "owner-guard-title", "owner-guard-reason",
  "owner-guard-ttl", "owner-guard-idle", "owner-guard-windows",
  "owner-arm-reload",
]) element(id);
element("owner-arm-minutes", "60");
element("owner-idle-minutes", "10");

const modes = ["locked", "readonly", "armed"].map((mode) => {
  const item = element(`mode-${mode}`);
  item.dataset.ownerMode = mode;
  return item;
});
const presets = [15, 30, 60, 120, 240, 480].map((minutes) => {
  const item = element(`duration-${minutes}`);
  item.dataset.ownerDuration = String(minutes);
  return item;
});
const requests = [];
const notices = [];
let confirmCount = 0;
let confirmResponse = true;
let pendingResponse = null;

const context = vm.createContext({
  document: {
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) =>
      selector === "[data-owner-mode]" ? modes
        : selector === "[data-owner-duration]" ? presets : [],
  },
  async api(_path, options) {
    assert.equal(options.method, "PUT");
    const body = JSON.parse(options.body);
    requests.push(body);
    if (pendingResponse) return pendingResponse;
    return { status: armStatus(body.minutes, body.idle_minutes) };
  },
  toast: (message, isError) => notices.push({ message, isError }),
  confirm: () => { confirmCount++; return confirmResponse; },
});

vm.runInContext(
  "let ownerGuardStatus = null; let ownerGuardBusy = false; let ownerGuardInputsInitialized = false;\n"
    + source.slice(begin, end),
  context,
);

function armStatus(minutes, idle = 10, effective = "armed") {
  const start = Date.now();
  return {
    mode: "armed", effective_mode: effective, reason: "owner mode armed",
    armed_at: new Date(start).toISOString(),
    expires_at: new Date(start + minutes * 60000).toISOString(),
    max_idle_minutes: idle, idle_minutes: 0, workstation_locked: false,
  };
}

const setStatus = (data) => {
  context.__status = data;
  vm.runInContext("ownerGuardStatus = __status; renderOwnerGuard()", context);
};
const setMode = (mode, effective = mode) => setStatus({
  ...armStatus(60), mode, effective_mode: effective,
  armed_at: mode === "armed" ? new Date().toISOString() : null,
  expires_at: mode === "armed" ? new Date(Date.now() + 60 * 60000).toISOString() : null,
});
const perform = async (mode, options) => {
  context.__mode = mode;
  context.__options = options;
  return vm.runInContext("setOwnerGuard(__mode, __options)", context);
};

setStatus(armStatus(120, 25));
assert.equal(vm.runInContext("lastArmDuration(__status)", context), 120);
assert.equal(elements.get("owner-arm-minutes").value, 120);
assert.equal(elements.get("owner-idle-minutes").value, 25);
assert.equal(elements.get("owner-arm-reload").disabled, false);
elements.get("owner-arm-minutes").value = "30"; // Unapplied edit must not change Reload duration.
await perform("armed", { source: "reload" });
assert.equal(requests.at(-1).minutes, 120);
assert.equal(requests.at(-1).idle_minutes, 25);
assert.equal(confirmCount, 0, "Reload while armed should be one-click");
assert.equal(elements.get("owner-arm-minutes").value, 120);

for (const minutes of [15, 30, 60, 120, 240, 480]) {
  await perform("armed", { source: "preset", duration: minutes });
  assert.equal(requests.at(-1).minutes, minutes);
  assert.equal(elements.get("owner-arm-minutes").value, minutes);
  assert.equal(presets.find((button) => Number(button.dataset.ownerDuration) === minutes).classList.contains("selected-duration"), true);
}
assert.equal(confirmCount, 0, "Quick presets while armed should be one-click");

setMode("locked");
assert.equal(elements.get("owner-arm-reload").disabled, true);
confirmResponse = false;
const beforeCancel = requests.length;
await perform("armed", { source: "preset", duration: 60 });
assert.equal(requests.length, beforeCancel, "Cancelled elevation must not write");
assert.equal(confirmCount, 1, "Elevation must require confirmation");

confirmResponse = true;
await perform("armed", { source: "preset", duration: 60 });
assert.equal(requests.length, beforeCancel + 1);
assert.equal(confirmCount, 2);
setStatus(armStatus(30, 10, "readonly"));
await perform("armed", { source: "reload" });
assert.equal(confirmCount, 3, "Reload after expiry/idle demotion requires confirmation");

setStatus(armStatus(30));
const beforeBadInput = requests.length;
elements.get("owner-idle-minutes").value = "0";
await perform("armed", { source: "reload" });
assert.equal(requests.length, beforeBadInput, "Invalid idle input must not write");
elements.get("owner-idle-minutes").value = "10";
elements.get("owner-arm-minutes").value = "1.5";
await perform("armed");
assert.equal(requests.length, beforeBadInput, "Fractional custom TTL must not write");
assert(notices.some((notice) => notice.isError), "Validation error should be visible");

console.log("Owner Guard UI quick Arm, Reload, confirmation, and input validation: PASS");