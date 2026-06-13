import type moment from "moment";
import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import {
  createDailyNote,
  getDailyNote,
  getAllDailyNotes,
} from "obsidian-daily-notes-interface";

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

declare global {
  interface Window {
    moment: typeof moment;
  }
}

export interface ISyncStatus {
  isSyncing: boolean;
  message: string;
}

export default class ThingsToolkitPlugin extends Plugin {
  public options: ISettings;
  public syncStatus: ISyncStatus = {
    isSyncing: false,
    message: "",
  };
  private syncTimeoutId: number;
  private settingsTab: ThingsToolkitSettingsTab;
  private statusBarEl: HTMLElement;

  async onload(): Promise<void> {
    if (!isMacOS()) {
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
      id: "sync-things-toolkit",
      name: "Sync",
      callback: () => setTimeout(() => this.tryToSyncLogbook(), 20),
    });
    this.addCommand({
      id: "open-things-toolkit-review",
      name: "Open review",
      callback: () => this.activateReviewView(),
    });

    this.addRibbonIcon(
      "calendar-check",
      "Open Things toolkit review",
      () => this.activateReviewView()
    );

    await this.loadOptions();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("things-toolkit-status");
    this.statusBarEl.addEventListener("click", () => this.activateReviewView());
    this.updateStatusBar();
    this.app.workspace.onLayoutReady(() => {
      this.refreshRecentDailyStats().then(() => {
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
          this.app.workspace.on("layout-ready", this.scheduleNextSync)
        );
      }
    }
  }

  async activateReviewView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_THINGS_TOOLKIT_REVIEW)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        return;
      }
      await leaf.setViewState({
        type: VIEW_TYPE_THINGS_TOOLKIT_REVIEW,
        active: true,
      });
    }
    await workspace.revealLeaf(leaf);
  }

  async tryToSyncLogbook(): Promise<void> {
    if (this.options.hasAcceptedDisclaimer) {
      await this.syncLogbook();
    } else {
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
  }

  async tryToScheduleSync(): Promise<void> {
    if (this.options.hasAcceptedDisclaimer) {
      this.scheduleNextSync();
    } else {
      new ConfirmationModal(this.app, {
        cta: "Sync",
        onAccept: async () => {
          await this.writeOptions({ hasAcceptedDisclaimer: true });
          this.scheduleNextSync();
        },
        onCancel: async () => {
          await this.writeOptions({ isSyncEnabled: false });
          // update the settings tab display
          this.settingsTab.display();
        },
        text:
          "Enabling sync will repair the configured review window from Things3 into Obsidian. This can create or modify many daily notes. Make sure to test the plugin in a test vault before continuing.",
        title: "Sync Now?",
      }).open();
    }
  }

  async syncLogbook(): Promise<void> {
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
    let taskCount = 0;
    let dayCount = 0;
    let changedDayCount = 0;

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
      taskCount = tasks.length;

      const daysToTasks: Record<string, ITask[]> = groupBy(
        tasks.filter((task) => task.stopDate),
        (task) => window.moment.unix(task.stopDate).startOf("day").format()
      );
      const dayEntries = Object.entries(daysToTasks).sort(([a], [b]) =>
        window.moment(a).diff(window.moment(b))
      );
      dayCount = dayEntries.length;
      const dailyStats = this.buildDailyStats(
        dayEntries,
        fetchResult.source,
        window.moment().unix()
      );

      for (const [dateStr, tasks] of dayEntries) {
        const date = window.moment(dateStr);

        let dailyNote = getDailyNote(date, dailyNotes);
        if (!dailyNote) {
          dailyNote = await createDailyNote(date);
        }

        const didChange = await updateSection(
          this.app,
          dailyNote,
          this.options.sectionHeading,
          logbookRenderer.render(tasks)
        );
        if (didChange) {
          changedDayCount++;
        }
      }

      await this.writeOptions({
        latestSyncTime: window.moment().unix(),
        dailyStats,
        thingsAccessStatus: fetchResult.accessStatus,
      });

      const sourceLabel =
        fetchResult.source === "applescript"
          ? `Things AppleScript, repairing last ${fetchResult.repairLookbackDays || this.options.appleScriptFallbackLookbackDays} days`
          : `Things SQLite, repairing last ${fetchResult.repairLookbackDays || this.getReviewWindowDayCount()} days`;
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
    const dailyStats = { ...(this.options.dailyStats || {}) };
    dayEntries.forEach(([dateStr, tasks]) => {
      const dateKey = window.moment(dateStr).format("YYYY-MM-DD");
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
    return Math.max(
      7,
      Math.floor(Number(this.options.reviewWindowDays) || 365)
    );
  }

  async refreshRecentDailyStats(dayCount = this.getReviewWindowDayCount()): Promise<void> {
    const dailyStats = { ...(this.options.dailyStats || {}) };
    const dailyNotes = getAllDailyNotes();
    const syncedAt = window.moment().unix();
    const end = window.moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");

    for (let date = start; date.isSameOrBefore(end); date.add(1, "day")) {
      const dateKey = date.format("YYYY-MM-DD");
      const dailyNote = getDailyNote(date, dailyNotes);
      if (!dailyNote) {
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
    let streak = 0;
    for (
      let date = window.moment().startOf("day");
      this.getTaskCountForDay(date.format("YYYY-MM-DD")) > 0;
      date = date.subtract(1, "day")
    ) {
      streak++;
    }
    return streak;
  }

  async writeDayReview(
    dateKey: string,
    diff: Partial<IDailyLogbookReview>
  ): Promise<void> {
    const dailyReviews = { ...(this.options.dailyReviews || {}) };
    const nextReview = {
      ...(dailyReviews[dateKey] || {}),
      ...diff,
      updatedAt: window.moment().unix(),
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
    const date = window.moment(dateKey, "YYYY-MM-DD");
    const dailyNotes = getAllDailyNotes();
    let dailyNote = getDailyNote(date, dailyNotes);
    if (!dailyNote) {
      dailyNote = await createDailyNote(date);
    }
    await this.app.workspace.getLeaf(false).openFile(dailyNote as TFile);
  }

  refreshReviewViews(): void {
    this.app.workspace
      .getLeavesOfType(VIEW_TYPE_THINGS_TOOLKIT_REVIEW)
      .forEach((leaf) => {
        if (leaf.view instanceof ThingsToolkitReviewView) {
          leaf.view.display();
        }
      });
  }

  updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }

    const todayKey = window.moment().format("YYYY-MM-DD");
    const todayCount = this.getTaskCountForDay(todayKey);
    const streak = this.getCurrentCompletionStreak();
    this.statusBarEl.setText(`Things: ${todayCount} today | ${streak}d streak`);
    this.statusBarEl.setAttribute(
      "aria-label",
      "Open Things toolkit review"
    );
  }

  cancelScheduledSync(): void {
    if (this.syncTimeoutId !== undefined) {
      window.clearTimeout(this.syncTimeoutId);
    }
  }

  scheduleNextSync(): void {
    const now = window.moment().unix();

    this.cancelScheduledSync();
    if (!this.options.isSyncEnabled || !this.options.syncInterval) {
      console.debug("[Things Toolkit] scheduling skipped, no syncInterval set");
      return;
    }

    const { latestSyncTime, syncInterval } = this.options;
    const secondsUntilNextSync = latestSyncTime + syncInterval - now;
    const nextSync = Math.max(secondsUntilNextSync * 1000, 20);

    console.debug(`[Things Toolkit] next sync scheduled in ${nextSync}ms`);
    this.syncTimeoutId = window.setTimeout(this.syncLogbook, nextSync);
  }

  async loadOptions(): Promise<void> {
    this.options = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.options.hasAcceptedDisclaimer) {
      // In case the user quits before accepting sync modal,
      // this keep the settings in sync
      this.options.isSyncEnabled = false;
    }
  }

  async writeOptions(diff: Partial<ISettings>): Promise<void> {
    this.options = Object.assign(this.options, diff);

    // Sync toggled on/off
    if (diff.isSyncEnabled !== undefined) {
      if (diff.isSyncEnabled) {
        this.tryToScheduleSync();
      } else {
        this.cancelScheduledSync();
      }
    } else if (diff.syncInterval !== undefined && this.options.isSyncEnabled) {
      // reschedule if interval changed
      this.tryToScheduleSync();
    }

    await this.saveData(this.options);
  }
}
