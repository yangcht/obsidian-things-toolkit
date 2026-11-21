import assert from "node:assert/strict";
import test from "node:test";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import type { App } from "obsidian";

import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  DEFAULT_SECTION_HEADING,
  MAX_REVIEW_WINDOW_DAYS,
  MIN_REVIEW_WINDOW_DAYS,
  normalizePositiveInteger,
  normalizeSectionHeading,
} from "../src/settingsUtils";
import type { ISettings } from "../src/settings";
import type { ITask } from "../src/things";

const bundle = await rollup({
  input: "src/renderer.ts",
  plugins: [
    {
      name: "obsidian-renderer-stub",
      resolveId: (id) => (id === "obsidian" ? id : null),
      load: (id) =>
        id === "obsidian" ? "export class MarkdownView {}" : null,
    },
    typescript({
      compilerOptions: { inlineSourceMap: false, inlineSources: false },
    }),
    resolve(),
  ],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();

const rendererModule = (await import(
  `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
)) as typeof import("../src/renderer");

function makeSettings(overrides: Partial<ISettings> = {}): ISettings {
  return {
    hasAcceptedDisclaimer: true,
    hasMigratedDailyReviewsToFrontmatter: true,
    latestSyncTime: 0,
    appleScriptFallbackLookbackDays: 365,
    thingsAccessMode: "auto",
    reviewWindowDays: 365,
    dailyStats: {},
    dailyReviews: {},
    doesSyncNoteBody: true,
    doesSyncProject: false,
    doesAddNewlineBeforeHeadings: false,
    isSyncEnabled: false,
    sectionHeading: "## Things",
    syncInterval: 1800,
    tagPrefix: "things/",
    canceledMark: "c",
    ...overrides,
  };
}

function makeApp(config?: { tabSize?: number; useTab?: boolean }): App {
  return {
    vault: {
      getConfig: (key: "useTab" | "tabSize") =>
        key === "useTab" ? config?.useTab : config?.tabSize,
    },
  } as unknown as App;
}

function makeTask(overrides: Partial<ITask> = {}): ITask {
  return {
    uuid: "task-1",
    title: "Task 1",
    notes: "",
    tags: [],
    startDate: 0,
    stopDate: 1700000000,
    cancelled: false,
    subtasks: [],
    ...overrides,
  };
}

test("renders uncategorized tasks before area/project headings so they are never misclassified", () => {
  const renderer = new rendererModule.ToolkitRenderer(makeApp(), makeSettings());
  const rendered = renderer.render([
    makeTask({ uuid: "t-work", title: "Work task", area: "Work", stopDate: 200 }),
    makeTask({ uuid: "t-inbox", title: "Inbox task", stopDate: 100 }),
  ]);

  assert.equal(
    rendered,
    [
      "## Things",
      "- [x] [Inbox task](things:///show?id=t-inbox)",
      "### Work",
      "- [x] [Work task](things:///show?id=t-work)",
    ].join("\n")
  );
});

test("defaults undefined vault tab settings to tab indentation instead of zero indentation", () => {
  const renderer = new rendererModule.ToolkitRenderer(
    makeApp({ useTab: undefined, tabSize: undefined }),
    makeSettings()
  );
  const rendered = renderer.renderTask(
    makeTask({
      notes: "Line 1\r\n\r\nLine 2",
      subtasks: [{ completed: false, title: "Sub 1" }],
    })
  );

  assert.equal(
    rendered,
    [
      "- [x] [Task 1](things:///show?id=task-1)",
      "\tLine 1",
      "\tLine 2",
      "\t- [ ] Sub 1",
    ].join("\n")
  );
});

test("defaults undefined tabSize to 4 spaces when useTab is false", () => {
  const renderer = new rendererModule.ToolkitRenderer(
    makeApp({ useTab: false, tabSize: undefined }),
    makeSettings()
  );
  const rendered = renderer.renderTask(
    makeTask({
      notes: "Note line",
    })
  );

  assert.equal(
    rendered,
    ["- [x] [Task 1](things:///show?id=task-1)", "    Note line"].join("\n")
  );
});

test("escapes brackets in task titles, clamps heading levels, strips leading # in tagPrefix, and guards empty canceledMark", () => {
  const renderer = new rendererModule.ToolkitRenderer(
    makeApp(),
    makeSettings({
      sectionHeading: "###### Things",
      tagPrefix: "#things/",
      canceledMark: "",
    })
  );
  const rendered = renderer.render([
    makeTask({
      uuid: "t-1",
      title: "[Q4] Ship\nrelease",
      area: "Engineering",
      cancelled: true,
      tags: ["High Priority"],
    }),
  ]);

  assert.equal(
    rendered,
    [
      "###### Things",
      "###### Engineering",
      "- [c] [\\[Q4\\] Ship release](things:///show?id=t-1) #things/high-priority",
    ].join("\n")
  );
});

test("normalizes section headings safely including hash-only inputs", () => {
  assert.equal(normalizeSectionHeading(""), DEFAULT_SECTION_HEADING);
  assert.equal(normalizeSectionHeading("###"), DEFAULT_SECTION_HEADING);
  assert.equal(normalizeSectionHeading("  ####   "), DEFAULT_SECTION_HEADING);
  assert.equal(normalizeSectionHeading("Things Log"), "## Things Log");
  assert.equal(normalizeSectionHeading("### Things Log"), "### Things Log");
  assert.equal(normalizeSectionHeading("####### Too Deep"), "## Too Deep");
});

test("normalizes positive integers safely against Infinity, NaN, zero, and bounds", () => {
  assert.equal(
    normalizePositiveInteger(
      Infinity,
      MIN_REVIEW_WINDOW_DAYS,
      DEFAULT_REVIEW_WINDOW_DAYS,
      MAX_REVIEW_WINDOW_DAYS
    ),
    DEFAULT_REVIEW_WINDOW_DAYS
  );
  assert.equal(
    normalizePositiveInteger(
      999999,
      MIN_REVIEW_WINDOW_DAYS,
      DEFAULT_REVIEW_WINDOW_DAYS,
      MAX_REVIEW_WINDOW_DAYS
    ),
    MAX_REVIEW_WINDOW_DAYS
  );
  assert.equal(
    normalizePositiveInteger(
      5,
      MIN_REVIEW_WINDOW_DAYS,
      DEFAULT_REVIEW_WINDOW_DAYS,
      MAX_REVIEW_WINDOW_DAYS
    ),
    MIN_REVIEW_WINDOW_DAYS
  );
});
