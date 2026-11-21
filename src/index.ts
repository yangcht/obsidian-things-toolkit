import {
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  createDailyNote,
  DailyNotesFolderMissingError,
  getAllDailyNotes,
  getDateFromFile,
  getDailyNote,
} from "obsidian-daily-notes-interface";

import { getEditorForFile } from "./fileUtils";
import { getMoment, type MomentLike } from "./moment";
import { ConfirmationModal } from "./modal";
import { getNextSyncDelayMs } from "./scheduler";
import { ToolkitRenderer } from "./renderer";
import {
  isDailyReviewEmpty,
  readDailyReviewFromFrontmatter,
  writeDailyReviewToFrontmatter,
} from "./reviewPersistence";
import {
  type ReviewViewDisplayOptions,
  ThingsToolkitReviewView,
  VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
} from "./reviewView";
import {
  DEFAULT_REVIEW_WINDOW_DAYS,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_FREQUENCY_SECONDS,
  IDailyLogbookReview,
  IDailyLogbookStat,
  ISettings,
  MAX_REVIEW_WINDOW_DAYS,
  MIN_SYNC_FREQUENCY_SECONDS,
  normalizePositiveInteger,
  normalizeSectionHeading,
  ThingsToolkitSettingsTab,
} from "./settings";
import {
  buildTasksFromSQLRecords,
  DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS,
  fetchThingsToolkit,
  ITask,
} from "./things";
import {
  countThingsTasksInSection,
  groupBy,
  updateSection,
} from "./textUtils";

const PENDING_FRONTMATTER_TTL_MS = 10_000;
const METADATA_STALE_IGNORE_MS = 2_000;

interface IPendingFrontmatterReview {
  review: IDailyLogbookReview | null;
  writtenAtMs: number;
}

function isTFile(file: unknown): file is TFile {
  return file instanceof TFile;
}

function getDateKey(date: MomentLike): string {
  return date.format("YYYY-MM-DD");
}

function isSameDailyReview(
  left: IDailyLogbookReview | null | undefined,
  right: IDailyLogbookReview | null | undefined
): boolean {
  const normalizedLeft = left && !isDailyReviewEmpty(left) ? left : null;
  const normalizedRight = right && !isDailyReviewEmpty(right) ? right : null;

  if (!normalizedLeft && !normalizedRight) {
    return true;
  }
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft.rating === normalizedRight.rating &&
    (normalizedLeft.reflection ?? "") === (normalizedRight.reflection ?? "")
  );
}

function normalizeReviewObject(
  review: IDailyLogbookReview
): IDailyLogbookReview {
  const normalized: IDailyLogbookReview = {};
  if (review.rating) {
    normalized.rating = review.rating;
  }
  const trimmedReflection = review.reflection?.trim();
  if (trimmedReflection) {
    normalized.reflection = trimmedReflection;
  }
  if (typeof review.updatedAt === "number" && Number.isFinite(review.updatedAt)) {
    normalized.updatedAt = review.updatedAt;
  }
  return normalized;
}

function isDailyNotesFolderMissingError(err: unknown): boolean {
  if (err instanceof DailyNotesFolderMissingError) {
    return true;
  }
  if (err instanceof Error) {
    return (
      err.name === "DailyNotesFolderMissingError" ||
      err.message.includes("Failed to find daily notes folder")
    );
  }
  return false;
}

export interface ISyncStatus {
  isSyncing: boolean;
  message: string;
}

export default class ThingsToolkitPlugin extends Plugin {
  public options!: ISettings;
  public syncStatus: ISyncStatus = {
    isSyncing: false,
    message: "",
  };

  private syncTimeoutId?: number;
  private commandSyncTimeoutId?: number;
  private lastSyncAttemptTime = 0;
  private settingsTab?: ThingsToolkitSettingsTab;
  private selectedReviewDate = "";
  private statusBarEl?: HTMLElement;
  private isUnloaded = false;
  private refreshStatePromise: Promise<void> | null = null;
  private refreshStateQueued = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly pendingFrontmatterReviews = new Map<
    string,
    IPendingFrontmatterReview
  >();
  private readonly pendingDailyNoteCreations = new Map<string, Promise<TFile>>();

  async onload(): Promise<void> {
    this.isUnloaded = false;
    this.scheduleNextSync = this.scheduleNextSync.bind(this);
    this.syncLogbook = this.syncLogbook.bind(this);
    this.tryToScheduleSync = this.tryToScheduleSync.bind(this);
    this.tryToSyncLogbook = this.tryToSyncLogbook.bind(this);

    await this.loadOptions();
    if (this.isUnloaded) {
      return;
    }

    this.selectedReviewDate = getMoment()().format("YYYY-MM-DD");

    this.registerView(
      VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
      (leaf: WorkspaceLeaf) => new ThingsToolkitReviewView(leaf, this)
    );

    this.addCommand({
      id: "sync",
      name: "Sync",
      callback: () => {
        if (this.commandSyncTimeoutId !== undefined) {
          window.clearTimeout(this.commandSyncTimeoutId);
        }
        this.commandSyncTimeoutId = window.setTimeout(() => {
          this.commandSyncTimeoutId = undefined;
          if (!this.isUnloaded) {
            void this.tryToSyncLogbook();
          }
        }, 20);
      },
    });

    this.addCommand({
      id: "open-review",
      name: "Open review",
      callback: () => {
        void this.activateReviewView();
      },
    });

    this.addRibbonIcon("calendar-check", "Open Things Toolkit review", () => {
      void this.activateReviewView();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("things-toolkit-status");
    this.registerDomEvent(this.statusBarEl, "click", () => {
      void this.activateReviewView();
    });

    this.updateStatusBar();

    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        this.selectReviewDateFromFile(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        void this.handleDailyNoteMetadataChanged(file);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.isUnloaded) {
        return;
      }
      this.selectReviewDateFromFile(this.app.workspace.getActiveFile());
    });

    this.app.workspace.onLayoutReady(() => {
      if (this.isUnloaded) {
        return;
      }
      void this.refreshDailyReviewStateFromVault()
        .then(() => {
          if (this.isUnloaded) {
            return;
          }
          this.updateStatusBar();
          this.refreshReviewViews();
        })
        .catch((err) => {
          console.error("[Things Toolkit] Initial vault refresh failed", err);
        });
    });

    this.settingsTab = new ThingsToolkitSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    if (
      this.isSyncSupported() &&
      this.options.hasAcceptedDisclaimer &&
      this.options.isSyncEnabled
    ) {
      this.app.workspace.onLayoutReady(() => {
        if (!this.isUnloaded) {
          this.scheduleNextSync();
        }
      });
    }
  }

  onunload(): void {
    this.isUnloaded = true;
    this.cancelScheduledSync();
    if (this.commandSyncTimeoutId !== undefined) {
      window.clearTimeout(this.commandSyncTimeoutId);
      this.commandSyncTimeoutId = undefined;
    }
  }

  isSyncSupported(): boolean {
    return Platform.isDesktopApp && Platform.isMacOS;
  }

  getSelectedReviewDate(): string {
    return this.selectedReviewDate;
  }

  async selectReviewDate(
    dateKey: string,
    options: { openDailyNote?: boolean } = {}
  ): Promise<void> {
    this.selectedReviewDate = dateKey;
    this.refreshReviewViews();

    if (options.openDailyNote) {
      await this.openDailyNote(dateKey);
    }
  }

  private selectReviewDateFromFile(file: TFile | null): void {
    const dateKey = this.getDailyNoteDateKey(file);

    if (!dateKey || dateKey === this.selectedReviewDate) {
      return;
    }

    this.selectedReviewDate = dateKey;
    this.refreshReviewViews({ revealSelectedDate: true });
  }

  private getDailyNoteDateKey(file: TFile | null): string | null {
    if (!file) {
      return null;
    }

    return getDateFromFile(file, "day")?.format("YYYY-MM-DD") ?? null;
  }

  async activateReviewView(): Promise<void> {
    let leaf: WorkspaceLeaf | null | undefined = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_THINGS_TOOLKIT_REVIEW
    )[0];

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);

      if (!leaf) {
        return;
      }

      await leaf.setViewState({
        type: VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
        active: true,
      });
    }

    await this.app.workspace.revealLeaf(leaf);
  }

  async tryToSyncLogbook(): Promise<void> {
    if (!this.isSyncSupported()) {
      new Notice("Things Toolkit sync is only available on macOS desktop.");
      return;
    }

    if (this.options.hasAcceptedDisclaimer) {
      await this.syncLogbook();
      return;
    }

    new ConfirmationModal(this.app, {
      cta: "Sync",
      onAccept: async () => {
        await this.writeOptions({ hasAcceptedDisclaimer: true });
        await this.syncLogbook();
      },
      text:
        "Enabling sync will repair the configured review window from Things3 into Obsidian. This can create or modify many daily notes. Make sure to test the plugin in a test vault before continuing.",
      title: "Sync Now?",
    }).open();
  }

  tryToScheduleSync(): void {
    if (!this.isSyncSupported()) {
      this.cancelScheduledSync();
      return;
    }

    if (this.options.hasAcceptedDisclaimer) {
      this.scheduleNextSync();
      return;
    }

    new ConfirmationModal(this.app, {
      cta: "Sync",
      onAccept: async () => {
        await this.writeOptions({ hasAcceptedDisclaimer: true });
        this.scheduleNextSync();
      },
      onCancel: () => {
        void this.writeOptions({ isSyncEnabled: false }).then(() => {
          this.settingsTab?.refresh();
        });
      },
      text:
        "Enabling sync will repair the configured review window from Things3 into Obsidian. This can create or modify many daily notes. Make sure to test the plugin in a test vault before continuing.",
      title: "Sync Now?",
    }).open();
  }

  async syncLogbook(): Promise<void> {
    if (this.isUnloaded) {
      return;
    }

    const moment = getMoment();

    if (!this.isSyncSupported()) {
      new Notice("Things Toolkit sync is only available on macOS desktop.");
      return;
    }

    if (this.syncStatus.isSyncing) {
      new Notice("Things Toolkit sync already running");
      return;
    }

    const syncStartedAt = moment().unix();
    this.lastSyncAttemptTime = syncStartedAt;
    this.syncStatus = {
      isSyncing: true,
      message: "Syncing...",
    };
    this.settingsTab?.refresh();

    try {
      const logbookRenderer = new ToolkitRenderer(this.app, this.options);
      const dailyNotes = this.safeGetAllDailyNotes();
      const latestSyncTime = this.options.latestSyncTime || 0;

      const fetchResult = await fetchThingsToolkit(
        latestSyncTime,
        this.options.appleScriptFallbackLookbackDays,
        this.options.thingsAccessMode,
        this.getReviewWindowDayCount()
      );

      if (this.isUnloaded) {
        return;
      }

      const tasks: ITask[] = buildTasksFromSQLRecords(
        fetchResult.taskRecords,
        fetchResult.checklistRecords
      );
      const taskCount = tasks.length;

      const daysToTasks: Record<string, ITask[]> = groupBy(
        tasks.filter((task) => Number.isFinite(task.stopDate) && task.stopDate > 0),
        (task) => moment.unix(task.stopDate).startOf("day").format()
      );

      const dayEntries = Object.entries(daysToTasks).sort(([a], [b]) =>
        moment(a).diff(moment(b))
      );
      const dayCount = dayEntries.length;
      let changedDayCount = 0;

      for (const [dateStr, groupedTasks] of dayEntries) {
        if (this.isUnloaded) {
          return;
        }

        const date = moment(dateStr);
        const dateKey = getDateKey(date);
        let dailyNote: TFile | null | undefined = getDailyNote(
          date,
          dailyNotes
        );

        if (!dailyNote) {
          dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);
        }

        if (this.isUnloaded || !isTFile(dailyNote)) {
          continue;
        }

        const didChange = await updateSection(
          this.app,
          dailyNote,
          this.options.sectionHeading,
          logbookRenderer.render(groupedTasks)
        );

        if (didChange) {
          changedDayCount++;
        }
      }

      if (this.isUnloaded) {
        return;
      }

      const dailyStats = this.buildDailyStats(
        dayEntries,
        fetchResult.source,
        moment().unix()
      );

      await this.writeOptions({
        latestSyncTime: syncStartedAt,
        dailyStats,
        thingsAccessStatus: fetchResult.accessStatus,
      });

      const repairLookbackDays =
        fetchResult.repairLookbackDays ||
        (fetchResult.source === "applescript"
          ? this.options.appleScriptFallbackLookbackDays
          : this.getReviewWindowDayCount());

      const sourceLabel =
        fetchResult.source === "applescript"
          ? `Things AppleScript, repairing last ${repairLookbackDays} days`
          : `Things SQLite, repairing last ${repairLookbackDays} days`;

      this.syncStatus = {
        isSyncing: false,
        message: `Last result: ${taskCount} tasks, ${changedDayCount}/${dayCount} notes updated via ${sourceLabel}. ${fetchResult.accessStatus.message}`,
      };

      new Notice(
        `Things Toolkit sync complete (${taskCount} tasks, ${changedDayCount} notes updated)`
      );
    } catch (err) {
      console.error("[Things Toolkit] Sync failed", err);

      const errorMessage = err instanceof Error ? err.message : String(err);
      this.syncStatus = {
        isSyncing: false,
        message: `Last result: sync failed. ${errorMessage}`,
      };

      if (!this.isUnloaded) {
        new Notice("Things Toolkit sync failed");
      }
    } finally {
      this.syncStatus.isSyncing = false;

      if (!this.isUnloaded) {
        try {
          await this.refreshDailyReviewStateFromVault();
        } catch (refreshErr) {
          console.error(
            "[Things Toolkit] Failed to refresh review state after sync",
            refreshErr
          );
        }
      }

      if (!this.isUnloaded) {
        this.updateStatusBar();
        this.refreshReviewViews();
        this.settingsTab?.refresh();
        this.scheduleNextSync();
      }
    }
  }

  private safeGetAllDailyNotes(): Record<string, TFile> {
    try {
      return getAllDailyNotes();
    } catch (err) {
      if (isDailyNotesFolderMissingError(err)) {
        return {};
      }
      throw err;
    }
  }

  buildDailyStats(
    dayEntries: [string, ITask[]][],
    source: IDailyLogbookStat["source"],
    syncedAt: number
  ): Record<string, IDailyLogbookStat> {
    const moment = getMoment();
    const dailyStats: Record<string, IDailyLogbookStat> = {
      ...(this.options.dailyStats || {}),
    };

    dayEntries.forEach(([dateStr, tasks]) => {
      const dateKey = moment(dateStr).format("YYYY-MM-DD");

      dailyStats[dateKey] = {
        taskCount: tasks.length,
        source,
        syncedAt,
      };
    });

    return dailyStats;
  }

  getTaskCountForDay(dateKey: string): number {
    return this.options.dailyStats?.[dateKey]?.taskCount || 0;
  }

  getReviewWindowDayCount(): number {
    return normalizePositiveInteger(
      this.options.reviewWindowDays,
      7,
      DEFAULT_REVIEW_WINDOW_DAYS,
      MAX_REVIEW_WINDOW_DAYS
    );
  }

  async refreshRecentDailyStats(
    dayCount = this.getReviewWindowDayCount()
  ): Promise<void> {
    if (this.isUnloaded) {
      return;
    }

    const moment = getMoment();
    const windowStats: Record<string, IDailyLogbookStat> = {};
    const dailyNotes = this.safeGetAllDailyNotes();
    const syncedAt = moment().unix();
    const end = moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");
    const sectionHeading = this.options.sectionHeading;

    for (
      let date = start.clone();
      date.isSameOrBefore(end);
      date.add(1, "day")
    ) {
      if (this.isUnloaded) {
        return;
      }

      const dateKey = getDateKey(date);
      const dailyNote = getDailyNote(date, dailyNotes);

      if (!isTFile(dailyNote)) {
        windowStats[dateKey] = {
          taskCount: 0,
          source: "daily-note",
          syncedAt,
        };
        continue;
      }

      try {
        const editor = getEditorForFile(this.app, dailyNote);
        const fileContents = editor
          ? editor.getValue()
          : await this.app.vault.read(dailyNote);
        windowStats[dateKey] = {
          taskCount: countThingsTasksInSection(fileContents, sectionHeading),
          source: "daily-note",
          syncedAt,
        };
      } catch (err) {
        console.error(
          `[Things Toolkit] Failed to read daily note for ${dateKey}`,
          err
        );
      }
    }

    if (this.isUnloaded) {
      return;
    }

    await this.writeOptions({
      dailyStats: {
        ...(this.options.dailyStats || {}),
        ...windowStats,
      },
    });
  }

  async refreshDailyReviewStateFromVault(): Promise<void> {
    if (this.isUnloaded) {
      return;
    }

    if (this.refreshStatePromise) {
      this.refreshStateQueued = true;
      await this.refreshStatePromise;
      return;
    }

    const run = async (): Promise<void> => {
      do {
        this.refreshStateQueued = false;
        if (this.isUnloaded) {
          return;
        }
        await this.migrateDailyReviewsToFrontmatter();
        if (this.isUnloaded) {
          return;
        }
        await this.refreshRecentDailyStats();
        if (this.isUnloaded) {
          return;
        }
        await this.refreshRecentDailyReviews();
      } while (this.refreshStateQueued && !this.isUnloaded);
    };

    this.refreshStatePromise = run();

    try {
      await this.refreshStatePromise;
    } finally {
      this.refreshStatePromise = null;
    }
  }

  async refreshRecentDailyReviews(
    dayCount = this.getReviewWindowDayCount()
  ): Promise<void> {
    if (this.isUnloaded) {
      return;
    }

    const moment = getMoment();
    const dailyNotes = this.safeGetAllDailyNotes();
    const end = moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");
    const windowReviewUpdates = new Map<string, IDailyLogbookReview | null>();

    for (
      let date = start.clone();
      date.isSameOrBefore(end);
      date.add(1, "day")
    ) {
      const dateKey = getDateKey(date);
      const dailyNote = getDailyNote(date, dailyNotes);

      if (!isTFile(dailyNote)) {
        const pending = this.getActivePendingFrontmatterReview(dateKey);
        windowReviewUpdates.set(dateKey, pending ? pending.review : null);
        continue;
      }

      const cachedReview = this.readDailyReviewFromFile(dailyNote);
      const resolvedReview = this.resolveReviewWithPendingWrite(
        dateKey,
        cachedReview
      );
      windowReviewUpdates.set(dateKey, resolvedReview);
    }

    if (this.isUnloaded) {
      return;
    }

    const nextDailyReviews: Record<string, IDailyLogbookReview> = {
      ...(this.options.dailyReviews || {}),
    };
    windowReviewUpdates.forEach((review, dateKey) => {
      if (review) {
        nextDailyReviews[dateKey] = review;
      } else {
        delete nextDailyReviews[dateKey];
      }
    });

    await this.writeOptions({ dailyReviews: nextDailyReviews });
  }

  private getActivePendingFrontmatterReview(
    dateKey: string
  ): IPendingFrontmatterReview | null {
    const pending = this.pendingFrontmatterReviews.get(dateKey);
    if (!pending) {
      return null;
    }

    if (Date.now() - pending.writtenAtMs > PENDING_FRONTMATTER_TTL_MS) {
      this.pendingFrontmatterReviews.delete(dateKey);
      return null;
    }

    return pending;
  }

  private resolveReviewWithPendingWrite(
    dateKey: string,
    cachedReview: IDailyLogbookReview | null
  ): IDailyLogbookReview | null {
    const pending = this.getActivePendingFrontmatterReview(dateKey);
    if (!pending) {
      return cachedReview;
    }

    if (isSameDailyReview(cachedReview, pending.review)) {
      this.pendingFrontmatterReviews.delete(dateKey);
      return cachedReview;
    }

    return pending.review;
  }

  private async handleDailyNoteMetadataChanged(file: TFile): Promise<void> {
    if (this.isUnloaded) {
      return;
    }

    const dateKey = this.getDailyNoteDateKey(file);
    if (!dateKey) {
      return;
    }

    const cachedReview = this.readDailyReviewFromFile(file);
    const pending = this.getActivePendingFrontmatterReview(dateKey);
    if (pending) {
      if (isSameDailyReview(cachedReview, pending.review)) {
        this.pendingFrontmatterReviews.delete(dateKey);
      } else if (Date.now() - pending.writtenAtMs < METADATA_STALE_IGNORE_MS) {
        return;
      } else {
        this.pendingFrontmatterReviews.delete(dateKey);
      }
    }

    const currentReview = this.options.dailyReviews?.[dateKey] ?? null;
    if (isSameDailyReview(currentReview, cachedReview)) {
      return;
    }

    const dailyReviews: Record<string, IDailyLogbookReview> = {
      ...(this.options.dailyReviews || {}),
    };
    if (cachedReview) {
      dailyReviews[dateKey] = cachedReview;
    } else {
      delete dailyReviews[dateKey];
    }

    await this.writeOptions({ dailyReviews });
    if (!this.isUnloaded) {
      this.refreshReviewViews();
    }
  }

  private readDailyReviewFromFile(file: TFile): IDailyLogbookReview | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return readDailyReviewFromFrontmatter(frontmatter);
  }

  private async migrateDailyReviewsToFrontmatter(): Promise<void> {
    if (this.options.hasMigratedDailyReviewsToFrontmatter || this.isUnloaded) {
      return;
    }

    const moment = getMoment();
    const dailyReviews = this.options.dailyReviews || {};
    const entries = Object.entries(dailyReviews).filter(
      ([, review]) => !isDailyReviewEmpty(review)
    );
    let hadTransientFailure = false;

    for (const [dateKey, review] of entries) {
      if (this.isUnloaded) {
        return;
      }

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
        !moment(dateKey, "YYYY-MM-DD", true).isValid()
      ) {
        console.warn(
          `[Things Toolkit] Skipping invalid legacy daily review date: ${dateKey}`
        );
        continue;
      }

      try {
        const dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);
        const existingReview = this.readDailyReviewFromFile(dailyNote);

        if (existingReview) {
          continue;
        }

        let wroteReview = false;
        await this.app.fileManager.processFrontMatter(
          dailyNote,
          (frontmatter: Record<string, unknown>) => {
            if (readDailyReviewFromFrontmatter(frontmatter)) {
              return;
            }

            writeDailyReviewToFrontmatter(frontmatter, review);
            wroteReview = true;
          }
        );

        if (wroteReview) {
          this.pendingFrontmatterReviews.set(dateKey, {
            review: normalizeReviewObject(review),
            writtenAtMs: Date.now(),
          });
        }
      } catch (err) {
        hadTransientFailure = true;
        console.error(
          `[Things Toolkit] Failed to migrate daily review for ${dateKey}`,
          err
        );
      }
    }

    if (!hadTransientFailure && !this.isUnloaded) {
      await this.writeOptions({ hasMigratedDailyReviewsToFrontmatter: true });
    }
  }

  private async getOrCreateDailyNoteForDateKey(dateKey: string): Promise<TFile> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      throw new Error(`Invalid daily review date: ${dateKey}`);
    }

    const moment = getMoment();
    const date = moment(dateKey, "YYYY-MM-DD", true);
    if (!date.isValid()) {
      throw new Error(`Invalid daily review date: ${dateKey}`);
    }

    const dailyNotes = this.safeGetAllDailyNotes();
    const existingNote: TFile | null | undefined = getDailyNote(
      date,
      dailyNotes
    );

    if (isTFile(existingNote)) {
      return existingNote;
    }

    const inflightCreation = this.pendingDailyNoteCreations.get(dateKey);
    if (inflightCreation) {
      return inflightCreation;
    }

    const creationPromise = (async (): Promise<TFile> => {
      const createdNote = await createDailyNote(date);
      if (!isTFile(createdNote)) {
        throw new Error("Daily note could not be resolved as a file");
      }
      return createdNote;
    })();

    this.pendingDailyNoteCreations.set(dateKey, creationPromise);
    try {
      return await creationPromise;
    } finally {
      if (this.pendingDailyNoteCreations.get(dateKey) === creationPromise) {
        this.pendingDailyNoteCreations.delete(dateKey);
      }
    }
  }

  getCurrentCompletionStreak(): number {
    const moment = getMoment();
    let streak = 0;

    for (
      let date = moment().startOf("day");
      this.getTaskCountForDay(getDateKey(date)) > 0;
      date = date.clone().subtract(1, "day")
    ) {
      streak++;
    }

    return streak;
  }

  async writeDayReview(
    dateKey: string,
    diff: Partial<IDailyLogbookReview>
  ): Promise<void> {
    const moment = getMoment();
    const dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);
    const updatedAt = moment().unix();
    let savedReview: IDailyLogbookReview | null = null;

    await this.app.fileManager.processFrontMatter(
      dailyNote,
      (frontmatter: Record<string, unknown>) => {
        const baseReview =
          readDailyReviewFromFrontmatter(frontmatter) ??
          this.options.dailyReviews?.[dateKey] ??
          {};
        const mergedReview: IDailyLogbookReview = {
          ...baseReview,
          ...diff,
          updatedAt,
        };
        const normalizedReview = normalizeReviewObject(mergedReview);
        writeDailyReviewToFrontmatter(frontmatter, normalizedReview);
        savedReview = isDailyReviewEmpty(normalizedReview)
          ? null
          : normalizedReview;
      }
    );

    this.pendingFrontmatterReviews.set(dateKey, {
      review: savedReview,
      writtenAtMs: Date.now(),
    });

    const dailyReviews: Record<string, IDailyLogbookReview> = {
      ...(this.options.dailyReviews || {}),
    };
    if (savedReview) {
      dailyReviews[dateKey] = savedReview;
    } else {
      delete dailyReviews[dateKey];
    }

    await this.writeOptions({ dailyReviews });
    if (!this.isUnloaded) {
      this.refreshReviewViews();
    }
  }

  async openDailyNote(dateKey: string): Promise<void> {
    const dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);

    const leaf = this.getDailyNoteOpenLeaf();
    await leaf.openFile(dailyNote, { active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private getDailyNoteOpenLeaf(): WorkspaceLeaf {
    const rootLeaf = this.app.workspace.getMostRecentLeaf(
      this.app.workspace.rootSplit
    );

    if (rootLeaf?.view instanceof MarkdownView) {
      return rootLeaf;
    }

    return this.app.workspace.getLeaf("tab");
  }

  refreshReviewViews(options: ReviewViewDisplayOptions = {}): void {
    const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_THINGS_TOOLKIT_REVIEW
    );

    leaves.forEach((leaf: WorkspaceLeaf) => {
      const view = leaf.view;

      if (view instanceof ThingsToolkitReviewView) {
        view.display(options);
      }
    });
  }

  updateStatusBar(): void {
    const moment = getMoment();

    if (!this.statusBarEl) {
      return;
    }

    const todayKey = moment().format("YYYY-MM-DD");
    const todayCount = this.getTaskCountForDay(todayKey);
    const streak = this.getCurrentCompletionStreak();

    this.statusBarEl.setText(`Things: ${todayCount} today | ${streak}d streak`);
    this.statusBarEl.setAttribute("aria-label", "Open Things Toolkit review");
  }

  cancelScheduledSync(): void {
    if (this.syncTimeoutId !== undefined) {
      window.clearTimeout(this.syncTimeoutId);
      this.syncTimeoutId = undefined;
    }
  }

  scheduleNextSync(): void {
    const moment = getMoment();
    const now = moment().unix();

    this.cancelScheduledSync();

    if (
      this.isUnloaded ||
      !this.isSyncSupported() ||
      !this.options.isSyncEnabled ||
      !this.options.syncInterval
    ) {
      console.debug("[Things Toolkit] scheduling skipped, no syncInterval set");
      return;
    }

    const { latestSyncTime, syncInterval } = this.options;
    const nextSync = getNextSyncDelayMs(
      latestSyncTime,
      this.lastSyncAttemptTime,
      syncInterval,
      now
    );

    console.debug(`[Things Toolkit] next sync scheduled in ${nextSync}ms`);

    this.syncTimeoutId = window.setTimeout(() => {
      this.syncTimeoutId = undefined;
      if (!this.isUnloaded) {
        void this.syncLogbook();
      }
    }, nextSync);
  }

  async loadOptions(): Promise<void> {
    const loadedData = (await this.loadData()) as Partial<ISettings> | null;

    const merged: ISettings = {
      ...DEFAULT_SETTINGS,
      ...(loadedData ?? {}),
      dailyStats: { ...(loadedData?.dailyStats ?? {}) },
      dailyReviews: { ...(loadedData?.dailyReviews ?? {}) },
    };

    merged.sectionHeading = normalizeSectionHeading(merged.sectionHeading);
    merged.syncInterval = normalizePositiveInteger(
      merged.syncInterval,
      MIN_SYNC_FREQUENCY_SECONDS,
      DEFAULT_SYNC_FREQUENCY_SECONDS
    );
    merged.appleScriptFallbackLookbackDays = normalizePositiveInteger(
      merged.appleScriptFallbackLookbackDays,
      1,
      DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS
    );
    merged.reviewWindowDays = normalizePositiveInteger(
      merged.reviewWindowDays,
      7,
      DEFAULT_REVIEW_WINDOW_DAYS,
      MAX_REVIEW_WINDOW_DAYS
    );
    if (
      merged.thingsAccessMode !== "auto" &&
      merged.thingsAccessMode !== "applescript" &&
      merged.thingsAccessMode !== "sqlite"
    ) {
      merged.thingsAccessMode = "auto";
    }

    if (!merged.hasAcceptedDisclaimer) {
      merged.isSyncEnabled = false;
    }

    this.options = merged;
  }

  async writeOptions(diff: Partial<ISettings>): Promise<void> {
    const previousReviewWindowDays = this.options.reviewWindowDays;
    const previousSectionHeading = this.options.sectionHeading;
    this.options = Object.assign({}, this.options, diff);

    if (diff.isSyncEnabled !== undefined) {
      if (diff.isSyncEnabled) {
        this.tryToScheduleSync();
      } else {
        this.cancelScheduledSync();
      }
    } else if (diff.syncInterval !== undefined && this.options.isSyncEnabled) {
      this.tryToScheduleSync();
    }

    const persist = this.saveQueue.then(() => this.saveData(this.options));
    this.saveQueue = persist.catch(() => {});
    await persist;

    const didChangeReviewInputs =
      (diff.reviewWindowDays !== undefined &&
        diff.reviewWindowDays !== previousReviewWindowDays) ||
      (diff.sectionHeading !== undefined &&
        diff.sectionHeading !== previousSectionHeading);

    if (didChangeReviewInputs && !this.isUnloaded) {
      void this.refreshDailyReviewStateFromVault()
        .then(() => {
          if (!this.isUnloaded) {
            this.updateStatusBar();
            this.refreshReviewViews();
          }
        })
        .catch((err) => {
          console.error(
            "[Things Toolkit] Failed to refresh review state after settings update",
            err
          );
        });
    }
  }
}
