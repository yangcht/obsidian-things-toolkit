import assert from "node:assert/strict";
import test from "node:test";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import type { App, Editor, TFile } from "obsidian";

// Bundle against a minimal host boundary; Obsidian's package provides types only.
const bundle = await rollup({
  input: "src/textUtils.ts",
  plugins: [
    {
      name: "obsidian-test-host",
      resolveId: (id) => id === "obsidian" ? id : null,
      load: (id) => id === "obsidian"
        ? "export class MarkdownView { static [Symbol.hasInstance](view) { return view.isMarkdown === true; } }"
        : null,
    },
    typescript({ compilerOptions: { inlineSourceMap: false, inlineSources: false } }),
    resolve(),
  ],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();
const utilities = await import(
  `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
) as typeof import("../src/textUtils");

const file = {} as TFile;
const section = "## Things\n- [x] [Task](things:///show?id=task)";

test("groups project names that match JavaScript object properties", () => {
  const names = ["__proto__", "constructor", "toString", "__proto__"];
  const result = utilities.groupBy(names, (name) => name);
  assert.deepEqual(Object.keys(result), ["__proto__", "constructor", "toString"]);
  assert.deepEqual(result.__proto__, ["__proto__", "__proto__"]);
  assert.deepEqual(result.constructor, ["constructor"]);
  assert.deepEqual(result.toString, ["toString"]);
});

test("uses the current contents inside the atomic vault update", async () => {
  let contents = "# Journal\nA concurrent edit.";
  const app = {
    workspace: { iterateAllLeaves: () => {} },
    vault: {
      read: () => { throw new Error("Must not read a stale snapshot"); },
      process: async (_file: TFile, update: (value: string) => string) => {
        contents = update(contents);
      },
    },
  } as unknown as App;
  assert.equal(await utilities.updateSection(app, file, "## Things", section), true);
  assert.ok(contents.startsWith("# Journal\nA concurrent edit.\n"));
  assert.equal(await utilities.updateSection(app, file, "## Things", section), false);
});

test("uses unsaved editor contents and preserves trailing text", async () => {
  let contents = "# Journal\nUnsaved text.";
  const editor = {
    getValue: () => contents,
    replaceRange: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
      const offset = (position: { line: number; ch: number }) =>
        contents.split("\n").slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.ch;
      contents = contents.slice(0, offset(from)) + text + contents.slice(offset(to));
    },
  } as unknown as Editor;
  const app = {
    workspace: {
      iterateAllLeaves: (callback: (leaf: unknown) => void) => {
        callback({ view: { isMarkdown: true, file, editor } });
      },
    },
    vault: {
      read: () => { throw new Error("Must use the editor buffer"); },
      process: () => { throw new Error("Must use editor edits"); },
    },
  } as unknown as App;
  assert.equal(await utilities.updateSection(app, file, "## Things", section), true);
  assert.ok(contents.startsWith("# Journal\nUnsaved text.\n"));
  contents += "\nPersonal reflection.";
  assert.equal(await utilities.updateSection(app, file, "## Things", section), false);
  assert.equal(await utilities.updateSection(app, file, "## Things", section.replace("[Task]", "[Renamed]")), true);
  assert.ok(contents.endsWith("\nPersonal reflection."));
  assert.ok(contents.includes("[Renamed]"));
});
