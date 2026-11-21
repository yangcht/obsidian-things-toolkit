import assert from "node:assert/strict";
import test from "node:test";
import { rollup } from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import type { App, PluginManifest } from "obsidian";

import type { ITaskRecord, IThingsToolkitFetchResult } from "../src/things";

interface FakeTimer {
  callback: () => void;
  cleared: boolean;
  delay: number;
  id: number;
}

const obsidianHostStub = `
  function pad2(n) { return String(n).padStart(2, "0"); }
  function wrapDate(date, valid = true) {
    return {
      _date: date,
      _valid: valid,
      isValid() { return this._valid; },
      clone() { return wrapDate(new Date(this._date.getTime()), this._valid); },
      startOf(unit) {
        if (unit === "day") this._date.setUTCHours(0, 0, 0, 0);
        return this;
      },
      add(amount, unit) {
        if (unit === "day" || unit === "days") this._date.setUTCDate(this._date.getUTCDate() + amount);
        return this;
      },
      subtract(amount, unit) { return this.add(-amount, unit); },
      isSameOrBefore(other) { return this.format("YYYY-MM-DD") <= other.format("YYYY-MM-DD"); },
      isBefore(other) { return this.format("YYYY-MM-DD") < other.format("YYYY-MM-DD"); },
      diff(other, unit, precise) {
        const ms = this._date.getTime() - other._date.getTime();
        if (unit === "days") return precise ? ms / 86400000 : Math.trunc(ms / 86400000);
        return ms;
      },
      unix() { return Math.floor(this._date.getTime() / 1000); },
      format(fmt) {
        const d = this._date;
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth();
        const day = d.getUTCDate();
        if (fmt === "YYYY-MM-DD") return y + "-" + pad2(m + 1) + "-" + pad2(day);
        return d.toISOString();
      },
    };
  }
  export function moment(input, format) {
    if (input === undefined) return wrapDate(new Date(Date.UTC(2026, 10, 21, 12, 0, 0)));
    if (typeof input === "string" && format === "YYYY-MM-DD") {
      const m = input.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
      if (!m) return wrapDate(new Date(NaN), false);
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
      const dt = new Date(Date.UTC(y, mo, d));
      const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d;
      return wrapDate(dt, valid);
    }
    return wrapDate(new Date(input));
  }
  moment.unix = (ts) => wrapDate(new Date(ts * 1000));

  export class TFile {
    constructor(path) { this.path = path; }
  }
  export class MarkdownView {
    static [Symbol.hasInstance](view) { return Boolean(view && view.isMarkdown === true); }
  }
  export class ItemView {
    constructor(leaf) { this.leaf = leaf; }
  }
  export class Modal {
    constructor(app) {
      this.app = app;
      const noopEl = {
        addClass() {}, setText() {}, createDiv() { return noopEl; },
        createEl() { return noopEl; }, addEventListener() {},
      };
      this.containerEl = noopEl;
      this.titleEl = noopEl;
      this.contentEl = noopEl;
      this.modalEl = noopEl;
    }
    open() {}
    close() {}
  }
  export class Notice {
    constructor(message) { globalThis.__lifecycleNotices?.push(message); }
  }
  export class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; }
  }
  export class Setting {}
  export const Platform = { isDesktopApp: true, isMacOS: true };
  export class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._data = null;
    }
    registerView() {}
    addCommand() {}
    addRibbonIcon() {}
    addSettingTab() {}
    registerEvent() {}
    registerDomEvent() {}
    addStatusBarItem() {
      return {
        text: "",
        addClass() {},
        setText(t) { this.text = t; },
        setAttribute() {},
        addEventListener() {},
      };
    }
    async loadData() { return this._data; }
    async saveData(data) { this._data = JSON.parse(JSON.stringify(data)); }
  }
`;

const dailyNotesStub = `
  import { TFile } from "obsidian";
  export class DailyNotesFolderMissingError extends Error {
    constructor(message = "Failed to find daily notes folder") {
      super(message);
      this.name = "DailyNotesFolderMissingError";
    }
  }
  export function getAllDailyNotes() {
    const state = globalThis.__dailyNotesHost;
    if (state.folderMissing) {
      throw new DailyNotesFolderMissingError();
    }
    return { ...state.notes };
  }
  export function getDailyNote(date, notes) {
    return notes[date.format("YYYY-MM-DD")] ?? null;
  }
  export async function createDailyNote(date) {
    const state = globalThis.__dailyNotesHost;
    state.createCalls = (state.createCalls || 0) + 1;
    await Promise.resolve();
    state.folderMissing = false;
    const key = date.format("YYYY-MM-DD");
    if (state.notes[key]) {
      throw new Error("File already exists: " + key);
    }
    const file = new TFile(key + ".md");
    state.notes[key] = file;
    state.contents.set(file, "");
    state.frontmatter.set(file, {});
    return file;
  }
  export function getDateFromFile(file) {
    const state = globalThis.__dailyNotesHost;
    for (const [key, note] of Object.entries(state.notes)) {
      if (note === file) {
        return { format: () => key };
      }
    }
    return null;
  }
`;

const thingsStub = `
  export const DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
  export const MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
  export function buildTasksFromSQLRecords(taskRecords) {
    return taskRecords.map((r) => ({
      uuid: r.uuid,
      title: r.title || "",
      notes: r.notes || "",
      area: r.area,
      project: r.project,
      tags: r.tag ? [r.tag] : [],
      startDate: r.startDate,
      stopDate: r.stopDate,
      cancelled: r.status === "2",
      subtasks: [],
    }));
  }
  export async function fetchThingsToolkit(...args) {
    return globalThis.__fetchThingsMock(...args);
  }
`;

const bundle = await rollup({
  input: "src/index.ts",
  plugins: [
    {
      name: "plugin-lifecycle-stubs",
      resolveId(id) {
        if (id === "obsidian") return "\0obsidian";
        if (id === "obsidian-daily-notes-interface") return "\0daily-notes";
        if (id === "./things") return "\0things";
        return null;
      },
      load(id) {
        if (id === "\0obsidian") return obsidianHostStub;
        if (id === "\0daily-notes") return dailyNotesStub;
        if (id === "\0things") return thingsStub;
        return null;
      },
    },
    typescript({
      compilerOptions: { inlineSourceMap: false, inlineSources: false },
    }),
    resolve({ browser: true }),
    commonjs(),
  ],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();

const pluginModule = (await import(
  `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
)) as { default: typeof import("../src/index").default };

function createHarness() {
  const timers: FakeTimer[] = [];
  let nextTimerId = 1;

  const fakeWindow = {
    setTimeout(callback: () => void, delay: number): number {
      const id = nextTimerId++;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id: number): void {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) {
        timer.cleared = true;
      }
    },
  };

  const dailyNotesHost = {
    createCalls: 0,
    folderMissing: false,
    notes: {} as Record<string, unknown>,
    contents: new Map<unknown, string>(),
    frontmatter: new Map<unknown, Record<string, unknown>>(),
    cachedFrontmatter: new Map<unknown, Record<string, unknown>>(),
    openEditors: new Map<unknown, { getValue: () => string; replaceRange: () => void }>(),
    readErrors: new Set<unknown>(),
  };

  const layoutCallbacks: Array<() => void> = [];
  const metadataChangedListeners: Array<(file: unknown) => void> = [];
  const notices: string[] = [];

  const app = {
    workspace: {
      on: () => ({}),
      onLayoutReady: (cb: () => void) => layoutCallbacks.push(cb),
      getActiveFile: () => null,
      getActiveViewOfType: () => null,
      iterateAllLeaves: (cb: (leaf: unknown) => void) => {
        for (const [file, editor] of dailyNotesHost.openEditors.entries()) {
          cb({ view: { isMarkdown: true, file, editor } });
        }
      },
      getLeavesOfType: () => [],
    },
    vault: {
      getConfig: () => true,
      read: async (file: unknown) => {
        if (dailyNotesHost.readErrors.has(file)) {
          throw new Error("Simulated vault.read EIO failure");
        }
        return dailyNotesHost.contents.get(file) ?? "";
      },
      process: async (file: unknown, updater: (text: string) => string) => {
        const next = updater(dailyNotesHost.contents.get(file) ?? "");
        dailyNotesHost.contents.set(file, next);
      },
    },
    metadataCache: {
      on: (event: string, cb: (file: unknown) => void) => {
        if (event === "changed") {
          metadataChangedListeners.push(cb);
        }
        return {};
      },
      getFileCache: (file: unknown) => {
        const fm = dailyNotesHost.cachedFrontmatter.get(file);
        return fm ? { frontmatter: fm } : undefined;
      },
    },
    fileManager: {
      processFrontMatter: async (
        file: unknown,
        updater: (fm: Record<string, unknown>) => void
      ) => {
        // Yield once to simulate asynchronous Obsidian frontmatter writes
        await Promise.resolve();
        const fm = dailyNotesHost.frontmatter.get(file) ?? {};
        updater(fm);
        dailyNotesHost.frontmatter.set(file, fm);
      },
    },
  } as unknown as App;

  const previousWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = fakeWindow;
  (globalThis as Record<string, unknown>).__dailyNotesHost = dailyNotesHost;
  (globalThis as Record<string, unknown>).__lifecycleNotices = notices;

  const plugin = new pluginModule.default(app, {} as PluginManifest);

  const cleanup = () => {
    plugin.onunload();
    if (previousWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = previousWindow;
    }
    delete (globalThis as Record<string, unknown>).__dailyNotesHost;
    delete (globalThis as Record<string, unknown>).__lifecycleNotices;
    delete (globalThis as Record<string, unknown>).__fetchThingsMock;
  };

  return {
    app,
    cleanup,
    dailyNotesHost,
    layoutCallbacks,
    metadataChangedListeners,
    notices,
    plugin,
    timers,
  };
}

test("onunload cancels scheduled sync and prevents rescheduling when unloaded mid-sync", async () => {
  const { cleanup, layoutCallbacks, plugin, timers } = createHarness();
  try {
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: true,
      isSyncEnabled: true,
      syncInterval: 1800,
      reviewWindowDays: 7,
    };

    await plugin.onload();
    layoutCallbacks.forEach((cb) => cb());

    const activeTimers = timers.filter((t) => !t.cleared);
    assert.equal(activeTimers.length, 1);

    // Simulate an in-flight sync during which the plugin is unloaded
    let releaseFetch!: () => void;
    (globalThis as Record<string, unknown>).__fetchThingsMock = () =>
      new Promise<IThingsToolkitFetchResult>((resolveFetch) => {
        releaseFetch = () =>
          resolveFetch({
            accessStatus: {
              message: "ok",
              source: "sqlite",
              sqliteBlocked: false,
              updatedAt: 100,
            },
            taskRecords: [
              {
                uuid: "t-1",
                title: "Task",
                notes: "",
                startDate: 0,
                stopDate: Math.floor(Date.UTC(2026, 10, 21, 9, 0, 0) / 1000),
                status: "3",
              } as ITaskRecord,
            ],
            checklistRecords: [],
            source: "sqlite",
            cutoffTime: 0,
            isLimited: false,
            repairLookbackDays: 7,
          });
      });

    const syncPromise = plugin.syncLogbook();
    plugin.onunload();
    assert.equal(timers.every((t) => t.cleared), true);

    releaseFetch();
    await syncPromise;

    assert.equal(plugin.syncStatus.isSyncing, false);
    assert.equal(timers.every((t) => t.cleared), true);
  } finally {
    cleanup();
  }
});

test("failed vault reads during sync refresh do not block next periodic sync scheduling", async () => {
  const { cleanup, dailyNotesHost, plugin, timers } = createHarness();
  try {
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: true,
      isSyncEnabled: true,
      syncInterval: 600,
      reviewWindowDays: 7,
    };
    await plugin.onload();

    // Even if refreshDailyReviewStateFromVault itself rejects, sync must still reschedule.
    plugin.refreshDailyReviewStateFromVault = async () => {
      throw new Error("Simulated refresh crash");
    };

    (globalThis as Record<string, unknown>).__fetchThingsMock = async () => ({
      accessStatus: {
        message: "ok",
        source: "sqlite",
        sqliteBlocked: false,
        updatedAt: 100,
      },
      taskRecords: [],
      checklistRecords: [],
      source: "sqlite",
      cutoffTime: 0,
      isLimited: false,
      repairLookbackDays: 7,
    });

    // Also verify DailyNotesFolderMissingError doesn't stick isSyncing = true
    dailyNotesHost.folderMissing = true;
    await plugin.syncLogbook();

    assert.equal(plugin.syncStatus.isSyncing, false);
    const activeTimers = timers.filter((t) => !t.cleared);
    assert.equal(activeTimers.length, 1);
    assert.equal(activeTimers[0].delay, 600_000);
  } finally {
    cleanup();
  }
});

test("migration followed immediately by refresh preserves migrated reviews despite stale metadataCache", async () => {
  const { cleanup, dailyNotesHost, plugin } = createHarness();
  try {
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: false,
      reviewWindowDays: 7,
      dailyReviews: {
        "2026-11-21": {
          rating: "good",
          reflection: "Migrated reflection",
          updatedAt: 1795176000,
        },
        "bad-date-key": {
          rating: "steady",
          reflection: "Invalid date must be skipped safely",
        },
      },
    };
    await plugin.onload();

    // Note: cachedFrontmatter stays empty (simulating async Obsidian metadataCache lag!)
    await plugin.refreshDailyReviewStateFromVault();

    assert.equal(plugin.options.hasMigratedDailyReviewsToFrontmatter, true);
    assert.equal(plugin.options.dailyReviews["2026-11-21"]?.rating, "good");
    assert.equal(
      plugin.options.dailyReviews["2026-11-21"]?.reflection,
      "Migrated reflection"
    );

    const createdFile = dailyNotesHost.notes["2026-11-21"];
    assert.ok(createdFile);
    assert.deepEqual(
      (dailyNotesHost.frontmatter.get(createdFile)?.things_toolkit_review as Record<string, unknown>)?.rating,
      "good"
    );
  } finally {
    cleanup();
  }
});

test("concurrent writeDayReview calls preserve both rating and reflection and handle missing folder", async () => {
  const { cleanup, dailyNotesHost, plugin } = createHarness();
  try {
    dailyNotesHost.folderMissing = true;
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: true,
      reviewWindowDays: 7,
    };
    await plugin.onload();

    await Promise.all([
      plugin.writeDayReview("2026-11-21", { rating: "good" }),
      plugin.writeDayReview("2026-11-21", { reflection: "Shipped clean fixes" }),
    ]);

    assert.equal(dailyNotesHost.createCalls, 1);
    const file = dailyNotesHost.notes["2026-11-21"];
    assert.ok(file);
    const reviewInFrontmatter = dailyNotesHost.frontmatter.get(file)
      ?.things_toolkit_review as Record<string, unknown>;
    assert.equal(reviewInFrontmatter?.rating, "good");
    assert.equal(reviewInFrontmatter?.reflection, "Shipped clean fixes");
    assert.equal(plugin.options.dailyReviews["2026-11-21"]?.rating, "good");
    assert.equal(
      plugin.options.dailyReviews["2026-11-21"]?.reflection,
      "Shipped clean fixes"
    );
  } finally {
    cleanup();
  }
});

test("refreshRecentDailyStats reads open editor buffer and isolates single-file vault read errors", async () => {
  const { cleanup, dailyNotesHost, plugin } = createHarness();
  try {
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: true,
      reviewWindowDays: 7,
      dailyStats: {
        "2026-11-20": { taskCount: 4, source: "daily-note", syncedAt: 1 },
      },
    };
    await plugin.onload();

    // Create two daily notes
    await plugin.writeDayReview("2026-11-21", { rating: "steady" });
    await plugin.writeDayReview("2026-11-20", { rating: "good" });
    const todayFile = dailyNotesHost.notes["2026-11-21"];
    const yesterdayFile = dailyNotesHost.notes["2026-11-20"];

    // Today's disk file is empty, but the open editor has 2 unsaved synced tasks!
    dailyNotesHost.contents.set(todayFile, "");
    dailyNotesHost.openEditors.set(todayFile, {
      getValue: () =>
        [
          "<!-- things-toolkit-logbook:start -->",
          "## Things",
          "- [x] [One](things:///show?id=one)",
          "- [-] [Two](things:///show?id=two)",
          "<!-- things-toolkit-logbook:end -->",
        ].join("\n"),
      replaceRange: () => {},
    });

    // Yesterday's file throws on vault.read — its previous stat (4) must be preserved
    // and must not crash the rest of the refresh!
    dailyNotesHost.readErrors.add(yesterdayFile);

    await plugin.refreshRecentDailyStats(7);

    assert.equal(plugin.getTaskCountForDay("2026-11-21"), 2);
    assert.equal(plugin.getTaskCountForDay("2026-11-20"), 4);
  } finally {
    cleanup();
  }
});

test("metadataCache changed event syncs manual frontmatter review edits live", async () => {
  const { cleanup, dailyNotesHost, metadataChangedListeners, plugin } =
    createHarness();
  try {
    (plugin as unknown as { _data: unknown })._data = {
      hasAcceptedDisclaimer: true,
      hasMigratedDailyReviewsToFrontmatter: true,
      reviewWindowDays: 7,
    };
    await plugin.onload();

    await plugin.writeDayReview("2026-11-21", { rating: "steady" });
    const todayFile = dailyNotesHost.notes["2026-11-21"];
    assert.ok(todayFile);

    // First cache event reflects the write we just made -> clears pending write cleanly
    dailyNotesHost.cachedFrontmatter.set(todayFile, {
      things_toolkit_review: { rating: "steady", updatedAt: 1000 },
    });
    metadataChangedListeners.forEach((cb) => cb(todayFile));
    await Promise.resolve();

    // Subsequent manual edit in the Markdown file updates rating + reflection live
    dailyNotesHost.cachedFrontmatter.set(todayFile, {
      things_toolkit_review: {
        rating: "improve",
        reflection: "Edited directly in frontmatter",
        updatedAt: 2000,
      },
    });
    metadataChangedListeners.forEach((cb) => cb(todayFile));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(plugin.options.dailyReviews["2026-11-21"]?.rating, "improve");
    assert.equal(
      plugin.options.dailyReviews["2026-11-21"]?.reflection,
      "Edited directly in frontmatter"
    );
  } finally {
    cleanup();
  }
});
