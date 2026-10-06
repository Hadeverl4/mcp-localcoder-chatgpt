import { toolResult } from "../dist/lib/tool-result.js";

let passed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

delete process.env.TOOL_RESULT_TEXT_MODE;
const summary = toolResult("probe", { value: 42, blob: "x".repeat(1000) });
const summaryText = JSON.parse(summary.content[0].text);
if (summaryText.data !== undefined) throw new Error("summary text duplicated data payload");
if (summary.structuredContent?.data?.value !== 42) throw new Error("structuredContent lost full payload");
ok("summary mode keeps full structuredContent without duplicating data in text");

process.env.TOOL_RESULT_TEXT_MODE = "full";
const full = toolResult("probe", { value: 42 });
const fullText = JSON.parse(full.content[0].text);
if (fullText.data?.value !== 42) throw new Error("full compatibility mode omitted data");
ok("full mode restores complete text payload");

delete process.env.TOOL_RESULT_TEXT_MODE;
console.log(`\n${passed} passed, 0 failed`);
