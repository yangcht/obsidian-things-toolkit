import {
  Notice,
  Platform,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from "obsidian-daily-notes-interface";

import { getMoment, type MomentLike } from "./moment";
import { ConfirmationModal } from "./modal";
import { ToolkitRenderer } from "./renderer";
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

function isTFile(file: unknown): file is TFile {
  return file instanceof TFile;
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
  private settingsTab?: ThingsToolkitSettingsTab;
  private statusBarEl?: HTMLElement;

  async onload(): Promise<void> {
    if (!Platform.isDesktopApp || !isMacOS()) {
      console.info(
        "Failed to load Things Toolkit plugin. Platform not supported"
      );
      return;
    }

    this.scheduleNextSync = this.scheduleNextSync.bind(this);
    this.syncLogbook = this.syncLogbook.bind(this);
    this.tryToScheduleSync = this.tryToScheduleSync.bind(this);
    this.tryToSyncLogbook = this.tryToSyncLogbook.bind(this);

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

    await this.loadOptions();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("things-toolkit-status");
    this.statusBarEl.addEventListener("click", () => {
      void this.activateReviewView();
    });

    this.updateStatusBar();

    this.app.workspace.onLayoutReady(() => {
      void this.refreshRecentDailyStats().then(() => {
        this.updateStatusBar();
        this.refreshReviewViews();
      });
    });

    this.settingsTab = new ThingsToolkitSettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    if (this.options.hasAcceptedDisclaimer && this.options.isSyncEnabled) {
      if (this.app.workspace.layoutReady) {
        this.scheduleNextSync();
      } else {
        this.registerEvent(
          this.app.workspace.on("layout-ready", () => {
            this.scheduleNextSync();
          })
        );
      }
    }
  }

  async activateReviewView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(
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

    if (this.syncStatus.isSyncing) {
      new Notice("Things Toolkit sync already running");
      return;
    }

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
        let dailyNote = getDailyNote(date, dailyNotes);

        if (!dailyNote) {
          dailyNote = await createDailyNote(date);
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
      await this.refreshRecentDailyStats();
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
      const dailyNote = getDailyNote(date, dailyNotes);

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

    if (!nextReview.rating && !nextReview.reflection) {
      delete dailyReviews[dateKey];
    } else {
      dailyReviews[dateKey] = nextReview;
    }

    await this.writeOptions({ dailyReviews });
    this.refreshReviewViews();
  }

  async openDailyNote(dateKey: string): Promise<void> {
    const moment = getMoment();
    const date = moment(dateKey, "YYYY-MM-DD");
    const dailyNotes = getAllDailyNotes();
    let dailyNote = getDailyNote(date, dailyNotes);

    if (!dailyNote) {
      dailyNote = await createDailyNote(date);
    }

    if (!isTFile(dailyNote)) {
      throw new Error("Daily note could not be opened as a file");
    }

    await this.app.workspace.getLeaf(false).openFile(dailyNote);
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

    if (!this.options.isSyncEnabled || !this.options.syncInterval) {
      console.debug("[Things Toolkit] scheduling skipped, no syncInterval set");
      return;
    }

    const { latestSyncTime, syncInterval } = this.options;
    const secondsUntilNextSync = latestSyncTime + syncInterval - now;
    const nextSync = Math.max(secondsUntilNextSync * 1000, 20);

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