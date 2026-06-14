import { App, PluginSettingTab, Setting, moment } from "obsidian";

import type ThingsToolkitPlugin from "./index";
import {
  DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS,
  IThingsAccessStatus,
  MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS,
  ThingsAccessMode,
  ThingsToolkitSource,
} from "./things";
import { getChildProcessModule } from "./nodeUtils";

export const DEFAULT_SECTION_HEADING = "## Things";
export const DEFAULT_SYNC_FREQUENCY_SECONDS = 30 * 60; // Every 30 minutes
export const DEFAULT_REVIEW_WINDOW_DAYS = 365;
export const DEFAULT_TAG_PREFIX = "things/";
export const DEFAULT_CANCELLED_MARK = "c";

export type DayReviewRating = "good" | "steady" | "improve";

export interface IDailyLogbookStat {
  taskCount: number;
  source: ThingsToolkitSource;
  syncedAt: number;
}

export interface IDailyLogbookReview {
  rating?: DayReviewRating;
  reflection?: string;
  updatedAt?: number;
}

export interface ISettings {
  hasAcceptedDisclaimer: boolean;
  latestSyncTime: number;
  appleScriptFallbackLookbackDays: number;
  thingsAccessMode: ThingsAccessMode;
  thingsAccessStatus?: IThingsAccessStatus;
  reviewWindowDays: number;
  dailyStats: Record<string, IDailyLogbookStat>;
  dailyReviews: Record<string, IDailyLogbookReview>;

  doesSyncNoteBody: boolean;
  doesSyncProject: boolean;
  doesAddNewlineBeforeHeadings: boolean;
  isSyncEnabled: boolean;
  sectionHeading: string;
  syncInterval: number;
  tagPrefix: string;
  canceledMark: string;
}

export const DEFAULT_SETTINGS = Object.freeze({
  hasAcceptedDisclaimer: false,
  latestSyncTime: 0,
  appleScriptFallbackLookbackDays: DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS,
  thingsAccessMode: "auto",
  thingsAccessStatus: undefined,
  reviewWindowDays: DEFAULT_REVIEW_WINDOW_DAYS,
  dailyStats: {},
  dailyReviews: {},

  doesSyncNoteBody: true,
  doesSyncProject: false,
  doesAddNewlineBeforeHeadings: false,
  isSyncEnabled: false,
  syncInterval: DEFAULT_SYNC_FREQUENCY_SECONDS,
  sectionHeading: DEFAULT_SECTION_HEADING,
  tagPrefix: DEFAULT_TAG_PREFIX,
  canceledMark: DEFAULT_CANCELLED_MARK
});

export class ThingsToolkitSettingsTab extends PluginSettingTab {
  private plugin: ThingsToolkitPlugin;

  constructor(app: App, plugin: ThingsToolkitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();

    new Setting(this.containerEl).setName("Sync Engine").setHeading();
    if (this.plugin.isSyncSupported()) {
      this.addResetLastSyncSetting();
      this.addThingsAccessModeSetting();
      this.addThingsAccessStatusSetting();
      this.addSyncEnabledSetting();
      this.addSyncIntervalSetting();
      this.addAppleScriptFallbackLookbackSetting();
    } else {
      this.addUnsupportedSyncSetting();
    }

    new Setting(this.containerEl).setName("Daily Notes").setHeading();
    this.addSectionHeadingSetting();
    this.addDoesSyncNoteBodySetting();
    this.addDoesSyncProjectSetting();
    this.addDoesAddNewlineBeforeHeadingsSetting();

    new Setting(this.containerEl).setName("Imported Tags").setHeading();
    this.addTagPrefixSetting();
    this.addCanceledMarkSetting();

    new Setting(this.containerEl).setName("Review Calendar").setHeading();
    this.addReviewWindowDaysSetting();
  }

  addSectionHeadingSetting(): void {
    new Setting(this.containerEl)
      .setName("Section heading")
      .setDesc(
        "Markdown heading to replace or append when adding Things items to a daily note"
      )
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.sectionHeading);
        textfield.onChange((rawSectionHeading) => {
          const sectionHeading = this.normalizeSectionHeading(rawSectionHeading);
          void this.plugin.writeOptions({ sectionHeading });
        });
      });
  }

  addReviewWindowDaysSetting(): void {
    new Setting(this.containerEl)
      .setName("Review window")
      .setDesc(
        "Number of recent days to show and repair in the review calendar"
      )
      .addText((textfield) => {
        textfield.setValue(String(this.plugin.options.reviewWindowDays));
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (e: FocusEvent) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          const reviewWindowDays = Math.max(
            30,
            Math.floor(Number(target.value) || DEFAULT_REVIEW_WINDOW_DAYS)
          );
          textfield.setValue(String(reviewWindowDays));
          void this.plugin.writeOptions({ reviewWindowDays });
        };
      });
  }

  normalizeSectionHeading(rawSectionHeading: string): string {
    const sectionHeading = rawSectionHeading.trim();
    if (!sectionHeading) {
      return DEFAULT_SECTION_HEADING;
    }
    if (/^#{1,6}\s+\S/.test(sectionHeading)) {
      return sectionHeading;
    }
    return `## ${sectionHeading.replace(/^#+\s*/, "")}`;
  }

  addSyncEnabledSetting(): void {
    new Setting(this.containerEl)
      .setName("Enable periodic syncing")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.isSyncEnabled);
        toggle.onChange((isSyncEnabled) => {
          void this.plugin.writeOptions({ isSyncEnabled });
        });
      });
  }

  addUnsupportedSyncSetting(): void {
    new Setting(this.containerEl)
      .setName("Sync unavailable")
      .setDesc(
        "Things sync runs only in Obsidian for macOS. The plugin can stay enabled here so Obsidian Sync does not disable it on your Mac."
      );
  }

  addThingsAccessModeSetting(): void {
    new Setting(this.containerEl)
      .setName("Things access")
      .setDesc(
        "Auto tries the Things database first, then uses AppleScript when macOS privacy blocks direct access."
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", "Auto")
          .addOption("applescript", "AppleScript")
          .addOption("sqlite", "SQLite only");
        dropdown.setValue(this.plugin.options.thingsAccessMode);
        dropdown.onChange(async (value: string) => {
          const thingsAccessMode = value as ThingsAccessMode;
          await this.plugin.writeOptions({ thingsAccessMode });
          this.display();
        });
      });
  }

  addThingsAccessStatusSetting(): void {
    const accessStatus = this.plugin.options.thingsAccessStatus;
    const statusText = accessStatus
      ? `${accessStatus.message} Checked ${moment.unix(accessStatus.updatedAt).fromNow()}.`
      : "Not checked yet. Run Sync now to test Things access.";

    new Setting(this.containerEl)
      .setName("macOS privacy status")
      .setDesc(statusText)
      .addButton((button) => {
        button.setButtonText("Full Disk Access");
        button.onClick(() => {
          void this.openSystemSettings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
          );
        });
      })
      .addButton((button) => {
        button.setButtonText("Automation");
        button.onClick(() => {
          void this.openSystemSettings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
          );
        });
      });
  }

  openSystemSettings(url: string): void {
    getChildProcessModule().spawn("open", [url]);
  }

  addDoesSyncNoteBodySetting(): void {
    new Setting(this.containerEl)
      .setName("Include notes")
      .setDesc('Includes MD notes of a task into the synced Obsidian document')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.options.doesSyncNoteBody);
        toggle.onChange((doesSyncNoteBody) => {
          void this.plugin.writeOptions({ doesSyncNoteBody });
        });
      });
  }

  addDoesSyncProjectSetting(): void {
    new Setting(this.containerEl)
        .setName("Include project")
        .setDesc("If the Things task belongs to a project, use project name as header instead of area")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.options.doesSyncProject);
          toggle.onChange((doesSyncProject) => {
            void this.plugin.writeOptions({ doesSyncProject });
          });
        });
  }

  addSyncIntervalSetting(): void {
    new Setting(this.containerEl)
      .setName("Sync frequency")
      .setDesc("Number of seconds the plugin will wait before syncing again")
      .addText((textfield) => {
        textfield.setValue(String(this.plugin.options.syncInterval));
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (e: FocusEvent) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          const syncInterval = Math.max(
            60,
            Math.floor(Number(target.value) || DEFAULT_SYNC_FREQUENCY_SECONDS)
          );
          textfield.setValue(String(syncInterval));
          void this.plugin.writeOptions({ syncInterval });
        };
      });
  }

  addAppleScriptFallbackLookbackSetting(): void {
    new Setting(this.containerEl)
      .setName("AppleScript fallback lookback")
      .setDesc(
        `Days to repair when macOS blocks direct Things database access. The recent review window always uses at least ${MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS} days.`
      )
      .addText((textfield) => {
        textfield.setValue(String(this.plugin.options.appleScriptFallbackLookbackDays));
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (e: FocusEvent) => {
          const target = e.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }
          const appleScriptFallbackLookbackDays = Math.max(
            1,
            Math.floor(Number(target.value) || DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS)
          );
          textfield.setValue(String(appleScriptFallbackLookbackDays));
          void this.plugin.writeOptions({ appleScriptFallbackLookbackDays });
        };
      });
  }

  addTagPrefixSetting(): void {
    new Setting(this.containerEl)
      .setName("Tag prefix")
      .setDesc(
        "Prefix added to Things tags when imported into Obsidian (e.g. #things/work)"
      )
      .addText((textfield) => {
        textfield.setValue(this.plugin.options.tagPrefix);
        textfield.onChange((tagPrefix) => {
          void this.plugin.writeOptions({ tagPrefix });
        });
      });
  }

  addCanceledMarkSetting(): void {
    new Setting(this.containerEl)
        .setName("Canceled mark")
        .setDesc(
            "Mark character to use for canceled tasks"
        )
        .addText((textfield) => {
          textfield.setValue(this.plugin.options.canceledMark);
          textfield.onChange((canceledMark) => {
            void this.plugin.writeOptions({ canceledMark });
          });
        });
  }

  addDoesAddNewlineBeforeHeadingsSetting(): void {
    new Setting(this.containerEl)
        .setName("Empty line before headings")
        .setDesc("When grouping tasks with headings by area or project, add an empty line before that heading")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.options.doesAddNewlineBeforeHeadings);
          toggle.onChange((doesAddNewlineBeforeHeadings) => {
            void this.plugin.writeOptions({ doesAddNewlineBeforeHeadings });
          });
        });
  }

  addResetLastSyncSetting(): void {
    const { latestSyncTime } = this.plugin.options;
    const { syncStatus } = this.plugin;
    const syncTime = latestSyncTime > 0 
      ? moment.unix(this.plugin.options.latestSyncTime).fromNow()
      : 'Never';

    new Setting(this.containerEl)
        .setDesc(createFragment(el => {
          el.appendText('Last sync: ');
          el.createSpan({ cls: 'u-pop', text: syncTime });
          if (syncStatus.message) {
            el.createEl("br");
            el.appendText(syncStatus.message);
          }
        }))
        .addButton(button => {
          button.setButtonText(syncStatus.isSyncing ? 'Syncing...' : 'Sync now');
          button.setClass('mod-cta');
          button.setDisabled(syncStatus.isSyncing);
          button.onClick(async () => {
            button.setDisabled(true);
            await this.plugin.tryToSyncLogbook();
            this.display();
          });
        })
        .addButton(button => {
          button.setButtonText('Reset sync history');
          button.setClass('mod-danger');
          button.setDisabled(syncStatus.isSyncing);
          button.onClick(() => {
            void this.plugin.writeOptions({ latestSyncTime: 0 });
            this.display();
          });
        })
        .addExtraButton(component => {
          component.setIcon('lucide-info');
          component.setTooltip('Resetting sync history will rewrite the configured Things section in matching daily notes.');
        });
  }
}
