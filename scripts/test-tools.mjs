import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { globFiles } from "../dist/lib/glob-search.js";
import { grepSearch } from "../dist/lib/grep-search.js";
import { inspectMatchingFiles, readManyTextFiles } from "../dist/lib/batch-files.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, isMultiFilePatch } from "../dist/lib/patch.js";
import { getFileRevision } from "../dist/lib/file-revision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp");

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

await fs.mkdir(tmpDir, { recursive: true });

await run("glob finds typescript files", async () => {
  const matches = await globFiles(root, "src/**/*.ts", 50);
  if (!matches.some((m) => m.path.endsWith("filesystem.ts"))) throw new Error("filesystem.ts not found");
});

await run("grep content mode", async () => {
  const out = await grepSearch({ pattern: "registerFilesystemTools", path: path.join(root, "src"), glob: "*.ts", headLimit: 10 });
  if (!out.includes("filesystem.ts")) throw new Error("pattern not found");
});

await run("grep files_with_matches mode", async () => {
  const out = await grepSearch({
    pattern: "createMcpServer",
    path: path.join(root, "src"),
    glob: "*.ts",
    outputMode: "files_with_matches",
    headLimit: 10,
  });
  if (!out.includes("server-factory")) throw new Error("file not listed");
});

await run("apply_patch codex style", async () => {
  const file = path.join(tmpDir, "sample.txt");
  await fs.writeFile(file, "hello\nworld\n");
  const next = applyUnifiedPatchToText("hello\nworld\n", "@@\n-hello\n+hi\n world\n");
  if (!next.includes("hi")) throw new Error("patch failed");
});

await run("read offset/limit simulation", async () => {
  const file = path.join(tmpDir, "lines.txt");
  await fs.writeFile(file, "a\nb\nc\nd\n");
  const lines = (await fs.readFile(file, "utf-8")).split("\n");
  const slice = lines.slice(1, 3);
  if (slice.join(",") !== "b,c") throw new Error(`unexpected ${slice}`);
});

await run("file revision changes after content mutation", async () => {
  const file = path.join(tmpDir, "revision.txt");
  await fs.writeFile(file, "alpha");
  const first = await getFileRevision(file);
  await fs.writeFile(file, "beta-longer");
  const second = await getFileRevision(file);
  if (first === second) throw new Error("revision did not change");
});

await run("read_many helper batches files with a global line cap", async () => {
  const a = path.join(tmpDir, "many-a.txt");
  const b = path.join(tmpDir, "many-b.txt");
  await fs.writeFile(a, "a1\na2\na3\na4\n");
  await fs.writeFile(b, "b1\nb2\nb3\nb4\n");
  const result = await readManyTextFiles(
    [
      { path: a, offset: 2, limit: 3 },
      { path: b, offset: 1, limit: 3 },
    ],
    4
  );
  if (result.files.length !== 2) throw new Error("expected two files");
  if (result.total_lines !== 4 || !result.truncated) throw new Error(JSON.stringify(result));
  if (!result.files[0].content.includes("a2") || !result.files[1].content.includes("b1")) {
    throw new Error("missing batched content");
  }
});

await run("inspect_files helper returns bounded numbered context", async () => {
  const dir = path.join(tmpDir, "inspect");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "one.ts"), "alpha\nneedle here\nomega\n");
  await fs.writeFile(path.join(dir, "two.ts"), "start\nneedle again\nend\n");
  const result = await inspectMatchingFiles({
    pattern: "needle",
    path: dir,
    glob: "*.ts",
    maxFiles: 2,
    contextAround: 1,
    maxLinesPerFile: 10,
  });
  if (result.file_count !== 2 || result.matches_returned !== 2) {
    throw new Error(JSON.stringify(result));
  }
  if (!result.files.every((file) => file.content.includes(">     2|"))) {
    throw new Error("match marker or line number missing");
  }
});

await run("edit replace_all simulation", async () => {
  const file = path.join(tmpDir, "repeat.txt");
  await fs.writeFile(file, "foo bar foo");
  const content = await fs.readFile(file, "utf-8");
  const next = content.split("foo").join("baz");
  await fs.writeFile(file, next);
  const result = await fs.readFile(file, "utf-8");
  if (result !== "baz bar baz") throw new Error(result);
});

await run("multi-file patch detection", async () => {
  const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-hello
+hi
*** End Patch`;
  if (!isMultiFilePatch(patch)) throw new Error("should detect multi-file patch");
});

await run("multi-file patch apply", async () => {
  const file = path.join(tmpDir, "multi.txt");
  await fs.writeFile(file, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+gamma
 beta
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.length !== 1 || !results[0].ok) throw new Error(JSON.stringify(results));
  const text = await fs.readFile(file, "utf-8");
  if (!text.includes("gamma")) throw new Error(text);
});

await run("delete and move file", async () => {
  const src = path.join(tmpDir, "move-me.txt");
  const dest = path.join(tmpDir, "moved.txt");
  await fs.writeFile(src, "payload");
  await fs.rename(src, dest);
  const text = await fs.readFile(dest, "utf-8");
  if (text !== "payload") throw new Error("move failed");
  await fs.unlink(dest);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);