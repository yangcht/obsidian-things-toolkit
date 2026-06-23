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
  getAllDailyNotes,
  getDateFromFile,
  getDailyNote,
} from "obsidian-daily-notes-interface";

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
  ThingsToolkitReviewView,
  VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
} from "./reviewView";
import {
  DEFAULT_SETTINGS,
  IDailyLogbookReview,
  IDailyLogbookStat,
  ISettings,
  ThingsToolkitSettingsTab,
} from "./settings";
import {
  buildTasksFromSQLRecords,
  fetchThingsToolkit,
  ITask,
} from "./things";
import {
  countThingsTasksInSection,
  groupBy,
  isMacOS,
  updateSection,
} from "./textUtils";

type DailyNoteDate = Parameters<typeof getDailyNote>[0];

function isTFile(file: unknown): file is TFile {
  return file instanceof TFile;
}

function toDailyNoteDate(date: MomentLike): DailyNoteDate {
  return date as unknown as DailyNoteDate;
}

function getDateKey(date: MomentLike): string {
  return date.format("YYYY-MM-DD");
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
  private lastSyncAttemptTime = 0;
  private settingsTab?: ThingsToolkitSettingsTab;
  private selectedReviewDate = "";
  private statusBarEl?: HTMLElement;

  async onload(): Promise<void> {
    this.scheduleNextSync = this.scheduleNextSync.bind(this);
    this.syncLogbook = this.syncLogbook.bind(this);
    this.tryToScheduleSync = this.tryToScheduleSync.bind(this);
    this.tryToSyncLogbook = this.tryToSyncLogbook.bind(this);

    await this.loadOptions();
    this.selectedReviewDate = getMoment()().format("YYYY-MM-DD");

    this.registerView(
      VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
      (leaf: WorkspaceLeaf) => new ThingsToolkitReviewView(leaf, this)
    );

    this.addCommand({
      id: "sync",
      name: "Sync",
      callback: () => {
        window.setTimeout(() => {
          void this.tryToSyncLogbook();
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

    this.addRibbonIcon("calendar-check", "Open Things toolkit review", () => {
      void this.activateReviewView();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("things-toolkit-status");
    this.statusBarEl.addEventListener("click", () => {
      void this.activateReviewView();
    });

    this.updateStatusBar();

    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        this.selectReviewDateFromFile(file);
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.selectReviewDateFromFile(this.app.workspace.getActiveFile());
    });

    this.app.workspace.onLayoutReady(() => {
      void this.refreshDailyReviewStateFromVault().then(() => {
        this.updateStatusBar();
        this.refreshReviewViews();
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
        this.scheduleNextSync();
      });
    }
  }

  isSyncSupported(): boolean {
    return Platform.isDesktopApp && isMacOS();
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
    this.refreshReviewViews();
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
          this.settingsTab?.display();
        });
      },
      text:
        "Enabling sync will repair the configured review window from Things3 into Obsidian. This can create or modify many daily notes. Make sure to test the plugin in a test vault before continuing.",
      title: "Sync Now?",
    }).open();
  }

  async syncLogbook(): Promise<void> {
    const moment = getMoment();

    if (!this.isSyncSupported()) {
      new Notice("Things Toolkit sync is only available on macOS desktop.");
      return;
    }

    if (this.syncStatus.isSyncing) {
      new Notice("Things Toolkit sync already running");
      return;
    }

    this.lastSyncAttemptTime = moment().unix();
    this.syncStatus = {
      isSyncing: true,
      message: "Syncing...",
    };
    this.settingsTab?.display();

    const logbookRenderer = new ToolkitRenderer(this.app, this.options);
    const dailyNotes = getAllDailyNotes();
    const latestSyncTime = this.options.latestSyncTime || 0;

    try {
      const fetchResult = await fetchThingsToolkit(
        latestSyncTime,
        this.options.appleScriptFallbackLookbackDays,
        this.options.thingsAccessMode,
        this.getReviewWindowDayCount()
      );

      const tasks: ITask[] = buildTasksFromSQLRecords(
        fetchResult.taskRecords,
        fetchResult.checklistRecords
      );
      const taskCount = tasks.length;

      const daysToTasks: Record<string, ITask[]> = groupBy(
        tasks.filter((task) => task.stopDate),
        (task) => moment.unix(task.stopDate).startOf("day").format()
      );

      const dayEntries = Object.entries(daysToTasks).sort(([a], [b]) =>
        moment(a).diff(moment(b))
      );
      const dayCount = dayEntries.length;
      let changedDayCount = 0;

      const dailyStats = this.buildDailyStats(
        dayEntries,
        fetchResult.source,
        moment().unix()
      );

      for (const [dateStr, groupedTasks] of dayEntries) {
        const date = moment(dateStr);
        let dailyNote = getDailyNote(toDailyNoteDate(date), dailyNotes);

        if (!dailyNote) {
          dailyNote = await createDailyNote(toDailyNoteDate(date));
        }

        if (!isTFile(dailyNote)) {
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

      await this.writeOptions({
        latestSyncTime: moment().unix(),
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

      new Notice("Things Toolkit sync failed");
    } finally {
      await this.refreshDailyReviewStateFromVault();
      this.updateStatusBar();
      this.refreshReviewViews();
      this.settingsTab?.display();
      this.scheduleNextSync();
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
    return Math.max(7, Math.floor(Number(this.options.reviewWindowDays) || 365));
  }

  async refreshRecentDailyStats(
    dayCount = this.getReviewWindowDayCount()
  ): Promise<void> {
    const moment = getMoment();
    const dailyStats: Record<string, IDailyLogbookStat> = {
      ...(this.options.dailyStats || {}),
    };
    const dailyNotes = getAllDailyNotes();
    const syncedAt = moment().unix();
    const end = moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");

    for (
      let date = start.clone();
      date.isSameOrBefore(end);
      date.add(1, "day")
    ) {
      const dateKey = getDateKey(date);
      const dailyNote = getDailyNote(toDailyNoteDate(date), dailyNotes);

      if (!isTFile(dailyNote)) {
        dailyStats[dateKey] = {
          taskCount: 0,
          source: "daily-note",
          syncedAt,
        };
        continue;
      }

      const fileContents = await this.app.vault.read(dailyNote);
      dailyStats[dateKey] = {
        taskCount: countThingsTasksInSection(
          fileContents,
          this.options.sectionHeading
        ),
        source: "daily-note",
        syncedAt,
      };
    }

    await this.writeOptions({ dailyStats });
  }

  async refreshDailyReviewStateFromVault(): Promise<void> {
    await this.migrateDailyReviewsToFrontmatter();
    await this.refreshRecentDailyStats();
    await this.refreshRecentDailyReviews();
  }

  async refreshRecentDailyReviews(
    dayCount = this.getReviewWindowDayCount()
  ): Promise<void> {
    const moment = getMoment();
    const dailyReviews: Record<string, IDailyLogbookReview> = {
      ...(this.options.dailyReviews || {}),
    };
    const dailyNotes = getAllDailyNotes();
    const end = moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");

    for (
      let date = start.clone();
      date.isSameOrBefore(end);
      date.add(1, "day")
    ) {
      const dateKey = getDateKey(date);
      const dailyNote = getDailyNote(toDailyNoteDate(date), dailyNotes);

      if (!isTFile(dailyNote)) {
        delete dailyReviews[dateKey];
        continue;
      }

      const review = this.readDailyReviewFromFile(dailyNote);
      if (review) {
        dailyReviews[dateKey] = review;
      } else {
        delete dailyReviews[dateKey];
      }
    }

    await this.writeOptions({ dailyReviews });
  }

  private readDailyReviewFromFile(file: TFile): IDailyLogbookReview | null {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return readDailyReviewFromFrontmatter(frontmatter);
  }

  private async migrateDailyReviewsToFrontmatter(): Promise<void> {
    const dailyReviews = this.options.dailyReviews || {};
    const entries = Object.entries(dailyReviews).filter(
      ([, review]) => !isDailyReviewEmpty(review)
    );

    for (const [dateKey, review] of entries) {
      const dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);
      const existingReview = this.readDailyReviewFromFile(dailyNote);

      if (existingReview) {
        continue;
      }

      await this.app.fileManager.processFrontMatter(dailyNote, (frontmatter) => {
        if (readDailyReviewFromFrontmatter(frontmatter)) {
          return;
        }

        writeDailyReviewToFrontmatter(frontmatter, review);
      });
    }
  }

  private async getOrCreateDailyNoteForDateKey(dateKey: string): Promise<TFile> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      throw new Error(`Invalid daily review date: ${dateKey}`);
    }
  
    const moment = getMoment();
    const date = moment(dateKey, "YYYY-MM-DD");
    const dailyNotes = getAllDailyNotes();
    let dailyNote = getDailyNote(toDailyNoteDate(date), dailyNotes);
  
    if (!dailyNote) {
      dailyNote = await createDailyNote(toDailyNoteDate(date));
    }
  
    if (!isTFile(dailyNote)) {
      throw new Error("Daily note could not be resolved as a file");
    }
  
    return dailyNote;
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
    const dailyReviews: Record<string, IDailyLogbookReview> = {
      ...(this.options.dailyReviews || {}),
    };

    const nextReview: IDailyLogbookReview = {
      ...(dailyReviews[dateKey] || {}),
      ...diff,
      updatedAt: moment().unix(),
    };

    if (nextReview.reflection !== undefined) {
      nextReview.reflection = nextReview.reflection.trim();
    }

    const dailyNote = await this.getOrCreateDailyNoteForDateKey(dateKey);

    await this.app.fileManager.processFrontMatter(dailyNote, (frontmatter) => {
      writeDailyReviewToFrontmatter(frontmatter, nextReview);
    });

    if (isDailyReviewEmpty(nextReview)) {
      delete dailyReviews[dateKey];
    } else {
      dailyReviews[dateKey] = nextReview;
    }

    await this.writeOptions({ dailyReviews });
    this.refreshReviewViews();
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

  refreshReviewViews(): void {
    const leaves: WorkspaceLeaf[] = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_THINGS_TOOLKIT_REVIEW
    );

    leaves.forEach((leaf: WorkspaceLeaf) => {
      const view = leaf.view;

      if (view instanceof ThingsToolkitReviewView) {
        view.display();
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
    this.statusBarEl.setAttribute("aria-label", "Open Things toolkit review");
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
      void this.syncLogbook();
    }, nextSync);
  }

  async loadOptions(): Promise<void> {
    const loadedData = (await this.loadData()) as Partial<ISettings> | null;

    this.options = {
      ...DEFAULT_SETTINGS,
      ...(loadedData ?? {}),
    };

    if (!this.options.hasAcceptedDisclaimer) {
      this.options.isSyncEnabled = false;
    }
  }

  async writeOptions(diff: Partial<ISettings>): Promise<void> {
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

    await this.saveData(this.options);
  }
}