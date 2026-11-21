import assert from "node:assert/strict";
import test from "node:test";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import type { WorkspaceLeaf } from "obsidian";

import { ReviewDraftStore } from "../src/reviewDrafts";
import type { IDailyLogbookReview, IDailyLogbookStat } from "../src/settings";
import type ThingsToolkitPlugin from "../src/index";

test("preserves unsaved drafts per date and clears only when unchanged after save", () => {
  const store = new ReviewDraftStore();

  assert.equal(store.getEditorValue("2026-11-21", "Saved note"), "Saved note");
  assert.equal(store.hasUnsavedDraft("2026-11-21", "Saved note"), false);

  store.setDraft("2026-11-21", "Draft in progress ", "Saved note");
  assert.equal(store.getEditorValue("2026-11-21", "Saved note"), "Draft in progress ");
  assert.equal(store.hasUnsavedDraft("2026-11-21", "Saved note"), true);

  // Separate date has its own draft state
  store.setDraft("2026-11-20", "Yesterday draft", undefined);
  assert.equal(store.getEditorValue("2026-11-20", undefined), "Yesterday draft");
  assert.equal(store.getEditorValue("2026-11-21", "Saved note"), "Draft in progress ");

  // Trailing space typed right after saved text is preserved for smooth typing,
  // without claiming meaningful unsaved changes once trimmed.
  store.setDraft("2026-11-19", "Hello ", "Hello");
  assert.equal(store.getEditorValue("2026-11-19", "Hello"), "Hello ");
  assert.equal(store.hasUnsavedDraft("2026-11-19", "Hello"), false);

  // Clearing a previously saved reflection counts as an unsaved change
  store.setDraft("2026-11-18", "", "Previously saved");
  assert.equal(store.getEditorValue("2026-11-18", "Previously saved"), "");
  assert.equal(store.hasUnsavedDraft("2026-11-18", "Previously saved"), true);

  // If user keeps typing while a save is in flight, clearDraftIfUnchanged keeps the newer edit
  store.setDraft("2026-11-21", "Draft in progress + more", "Saved note");
  store.clearDraftIfUnchanged("2026-11-21", "Draft in progress ");
  assert.equal(
    store.getEditorValue("2026-11-21", "Saved note"),
    "Draft in progress + more"
  );

  // Once the exact draft finishes saving, it clears cleanly
  store.clearDraftIfUnchanged("2026-11-21", "Draft in progress + more");
  assert.equal(
    store.getEditorValue("2026-11-21", "Draft in progress + more"),
    "Draft in progress + more"
  );
  assert.equal(store.hasUnsavedDraft("2026-11-21", "Draft in progress + more"), false);
});

// Minimal DOM & Obsidian mock to verify ThingsToolkitReviewView draft preservation,
// focus restoration across background refreshes, and rating toggle behavior.
class MockElement {
  public tagName: string;
  public classes = new Set<string>();
  public attrs = new Map<string, string>();
  public children: MockElement[] = [];
  public listeners = new Map<string, Array<(event: unknown) => void>>();
  public textContent = "";
  public value = "";
  public scrollTop = 0;
  public tabIndex = -1;
  public disabled = false;
  public selectionStart: number | null = 0;
  public selectionEnd: number | null = 0;
  public focused = false;

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  empty(): void {
    this.children = [];
    this.textContent = "";
  }

  addClass(cls: string): void {
    cls
      .split(/\s+/)
      .filter(Boolean)
      .forEach((name) => this.classes.add(name));
  }

  toggleClass(cls: string, value: boolean): void {
    if (value) {
      this.addClass(cls);
    } else {
      this.classes.delete(cls);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  setText(text: string): void {
    this.textContent = text;
  }

  createDiv(clsOrOpts?: string | { cls?: string; text?: string }): MockElement {
    return this.createEl("div", typeof clsOrOpts === "string" ? { cls: clsOrOpts } : clsOrOpts);
  }

  createSpan(opts?: { cls?: string; text?: string }): MockElement {
    return this.createEl("span", opts);
  }

  createEl(
    tag: string,
    opts?: { attr?: Record<string, string>; cls?: string; text?: string }
  ): MockElement {
    const el = new MockElement(tag);
    if (opts?.cls) {
      el.addClass(opts.cls);
    }
    if (opts?.text !== undefined) {
      el.textContent = opts.text;
    }
    if (opts?.attr) {
      Object.entries(opts.attr).forEach(([k, v]) => el.setAttribute(k, v));
    }
    this.children.push(el);
    return el;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: unknown = {}): void {
    (this.listeners.get(type) ?? []).forEach((listener) => listener(event));
  }

  focus(): void {
    this.focused = true;
    mockDocument.activeElement = this;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  getBoundingClientRect(): { bottom: number; top: number } {
    return { top: 0, bottom: 400 };
  }

  querySelector(selector: string): MockElement | null {
    const requiredClasses = selector
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean);
    const walk = (node: MockElement): MockElement | null => {
      for (const child of node.children) {
        if (requiredClasses.every((cls) => child.classes.has(cls))) {
          return child;
        }
        const nested = walk(child);
        if (nested) {
          return nested;
        }
      }
      return null;
    };
    return walk(this);
  }

  findAll(predicate: (el: MockElement) => boolean): MockElement[] {
    const matches: MockElement[] = [];
    const walk = (node: MockElement) => {
      for (const child of node.children) {
        if (predicate(child)) {
          matches.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
}

const mockDocument: { activeElement: MockElement | null } = {
  activeElement: null,
};

function buildMomentStubSource(): string {
  return `
    function pad2(n) { return String(n).padStart(2, "0"); }
    const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const DAYS_LONG = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

    function isoWeekNumber(date) {
      const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const dayNum = target.getUTCDay() || 7;
      target.setUTCDate(target.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
      return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    }

    function wrapDate(date, valid = true) {
      return {
        _date: date,
        _valid: valid,
        isValid() { return this._valid; },
        clone() { return wrapDate(new Date(this._date.getTime()), this._valid); },
        startOf(unit) {
          const d = this._date;
          if (unit === "day") d.setUTCHours(0, 0, 0, 0);
          else if (unit === "month") { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); }
          else if (unit === "isoWeek") {
            const day = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() - (day - 1));
            d.setUTCHours(0, 0, 0, 0);
          }
          return this;
        },
        endOf(unit) {
          const d = this._date;
          if (unit === "month") {
            d.setUTCMonth(d.getUTCMonth() + 1, 0);
            d.setUTCHours(23, 59, 59, 999);
          } else if (unit === "isoWeek") {
            const day = d.getUTCDay() || 7;
            d.setUTCDate(d.getUTCDate() + (7 - day));
            d.setUTCHours(23, 59, 59, 999);
          }
          return this;
        },
        add(amount, unit) {
          if (unit === "day" || unit === "days") this._date.setUTCDate(this._date.getUTCDate() + amount);
          else if (unit === "week" || unit === "weeks") this._date.setUTCDate(this._date.getUTCDate() + amount * 7);
          else if (unit === "month" || unit === "months") this._date.setUTCMonth(this._date.getUTCMonth() + amount);
          return this;
        },
        subtract(amount, unit) { return this.add(-amount, unit); },
        isSame(other, unit) {
          if (unit === "month") {
            return this._date.getUTCFullYear() === other._date.getUTCFullYear() &&
              this._date.getUTCMonth() === other._date.getUTCMonth();
          }
          return this.format("YYYY-MM-DD") === other.format("YYYY-MM-DD");
        },
        isBefore(other, unit) {
          return this.format(unit === "month" ? "YYYY-MM" : "YYYY-MM-DD") <
            other.format(unit === "month" ? "YYYY-MM" : "YYYY-MM-DD");
        },
        isAfter(other, unit) {
          return this.format(unit === "month" ? "YYYY-MM" : "YYYY-MM-DD") >
            other.format(unit === "month" ? "YYYY-MM" : "YYYY-MM-DD");
        },
        isSameOrBefore(other, unit) { return !this.isAfter(other, unit); },
        isoWeek() { return isoWeekNumber(this._date); },
        unix() { return Math.floor(this._date.getTime() / 1000); },
        format(fmt) {
          const d = this._date;
          const y = d.getUTCFullYear();
          const m = d.getUTCMonth();
          const day = d.getUTCDate();
          if (fmt === "YYYY-MM-DD") return y + "-" + pad2(m + 1) + "-" + pad2(day);
          if (fmt === "YYYY-MM") return y + "-" + pad2(m + 1);
          if (fmt === "D") return String(day);
          if (fmt === "MMM") return MONTHS_SHORT[m];
          if (fmt === "MMM D") return MONTHS_SHORT[m] + " " + day;
          if (fmt === "MMM D, YYYY") return MONTHS_SHORT[m] + " " + day + ", " + y;
          if (fmt === "MMMM YYYY") return MONTHS_LONG[m] + " " + y;
          if (fmt === "dddd, MMM D, YYYY") return DAYS_LONG[d.getUTCDay()] + ", " + MONTHS_SHORT[m] + " " + day + ", " + y;
          return d.toISOString();
        },
      };
    }

    export function moment(input, format, strict) {
      if (input === undefined) return wrapDate(new Date(Date.UTC(2026, 10, 21)));
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

    export class ItemView {
      constructor(leaf) {
        this.leaf = leaf;
        this.contentEl = globalThis.__mockContentElFactory();
      }
    }
    export class Notice {
      constructor(message) {
        globalThis.__notices.push(message);
      }
    }
  `;
}

const reviewViewBundle = await rollup({
  input: "src/reviewView.ts",
  plugins: [
    {
      name: "obsidian-review-view-stub",
      resolveId: (id) => (id === "obsidian" ? id : null),
      load: (id) => (id === "obsidian" ? buildMomentStubSource() : null),
    },
    typescript({
      compilerOptions: { inlineSourceMap: false, inlineSources: false },
    }),
    resolve(),
  ],
});
const { output: reviewViewOutput } = await reviewViewBundle.generate({
  format: "es",
});
await reviewViewBundle.close();

const reviewViewModule = (await import(
  `data:text/javascript;base64,${Buffer.from(reviewViewOutput[0].code).toString("base64")}`
)) as typeof import("../src/reviewView");

test("ThingsToolkitReviewView preserves unsaved drafts and focus across rating clicks, date navigation, and sync refreshes", async () => {
  const previousDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = mockDocument;
  (globalThis as Record<string, unknown>).__mockContentElFactory = () =>
    new MockElement("div");
  const notices: string[] = [];
  (globalThis as Record<string, unknown>).__notices = notices;

  try {
    let selectedDate = "2026-11-21";
    const dailyReviews: Record<string, IDailyLogbookReview> = {
      "2026-11-21": { reflection: "Initial saved note" },
    };
    const dailyStats: Record<string, IDailyLogbookStat> = {
      "2026-11-21": { taskCount: 3, source: "daily-note", syncedAt: 1000 },
    };

    let view!: InstanceType<typeof reviewViewModule.ThingsToolkitReviewView>;

    const plugin = {
      options: { dailyReviews, dailyStats },
      getSelectedReviewDate: () => selectedDate,
      getReviewWindowDayCount: () => 30,
      getTaskCountForDay: (dateKey: string) => dailyStats[dateKey]?.taskCount ?? 0,
      getCurrentCompletionStreak: () => 1,
      updateStatusBar: () => {},
      refreshDailyReviewStateFromVault: async () => {
        throw new Error("Simulated vault read error on open");
      },
      selectReviewDate: async (dateKey: string) => {
        selectedDate = dateKey;
        view.display();
      },
      openDailyNote: async () => {},
      writeDayReview: async (
        dateKey: string,
        diff: Partial<IDailyLogbookReview>
      ) => {
        const next: IDailyLogbookReview = {
          ...(dailyReviews[dateKey] ?? {}),
          ...diff,
        };
        if (!next.rating && !(next.reflection ?? "").trim()) {
          delete dailyReviews[dateKey];
        } else {
          dailyReviews[dateKey] = next;
        }
        view.display();
      },
    } as unknown as ThingsToolkitPlugin;

    view = new reviewViewModule.ThingsToolkitReviewView(
      {} as WorkspaceLeaf,
      plugin
    );

    // Even if vault refresh throws during onOpen, the view must still render.
    await view.onOpen();

    const getTextarea = (): MockElement => {
      const textarea = (view.contentEl as unknown as MockElement).querySelector(
        ".things-toolkit-review-reflection"
      );
      assert.ok(textarea, "reflection textarea should exist");
      return textarea;
    };

    // 1. User types an unsaved reflection draft while focused in the textarea.
    const textarea1 = getTextarea();
    assert.equal(textarea1.value, "Initial saved note");
    textarea1.focus();
    textarea1.value = "Unsaved work in progress";
    textarea1.setSelectionRange(7, 11);
    textarea1.dispatch("input");

    // 2. Background sync triggers a full view refresh — draft, focus, and cursor must survive!
    view.display();
    const textareaAfterSync = getTextarea();
    assert.equal(textareaAfterSync.value, "Unsaved work in progress");
    assert.equal(textareaAfterSync.focused, true);
    assert.equal(textareaAfterSync.selectionStart, 7);
    assert.equal(textareaAfterSync.selectionEnd, 11);

    // 3. Clicking a rating button must NOT discard the unsaved draft!
    const findButton = (text: string): MockElement => {
      const match = (view.contentEl as unknown as MockElement).findAll(
        (el) => el.tagName === "button" && el.textContent === text
      )[0];
      assert.ok(match, `button "${text}" should exist`);
      return match;
    };

    findButton("Good day").dispatch("click");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(dailyReviews["2026-11-21"]?.rating, "good");
    assert.equal(getTextarea().value, "Unsaved work in progress");

    // 4. Clicking the active rating button again toggles the rating OFF while preserving the draft!
    findButton("Good day").dispatch("click");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(dailyReviews["2026-11-21"]?.rating, undefined);
    assert.equal(getTextarea().value, "Unsaved work in progress");

    // 5. Navigating to another calendar date and coming back preserves the draft!
    await plugin.selectReviewDate("2026-11-20");
    assert.equal(getTextarea().value, "");

    await plugin.selectReviewDate("2026-11-21");
    assert.equal(getTextarea().value, "Unsaved work in progress");

    // 6. Clicking "Save reflection" persists the draft and notifies the user.
    findButton("Save reflection").dispatch("click");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      dailyReviews["2026-11-21"]?.reflection,
      "Unsaved work in progress"
    );
    assert.equal(notices.includes("Things review saved"), true);
  } finally {
    if (previousDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = previousDocument;
    }
    delete (globalThis as Record<string, unknown>).__mockContentElFactory;
    delete (globalThis as Record<string, unknown>).__notices;
  }
});
