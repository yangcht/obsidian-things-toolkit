import {
  App,
  PluginSettingTab,
  Setting,
  moment,
  type SettingDefinitionItem,
  type SettingGroupItem,
} from "obsidian";

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

type EditableSettingKey =
  | "appleScriptFallbackLookbackDays"
  | "canceledMark"
  | "doesAddNewlineBeforeHeadings"
  | "doesSyncNoteBody"
  | "doesSyncProject"
  | "isSyncEnabled"
  | "reviewWindowDays"
  | "sectionHeading"
  | "syncInterval"
  | "tagPrefix"
  | "thingsAccessMode";

function refreshDeclarativeSettings(tab: { update?: () => void }): boolean {
  if (typeof tab.update !== "function") {
    return false;
  }

  tab.update();
  return true;
}

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
  hasMigratedDailyReviewsToFrontmatter: boolean;
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

export const DEFAULT_SETTINGS: Readonly<ISettings> = Object.freeze({
  hasAcceptedDisclaimer: false,
  hasMigratedDailyReviewsToFrontmatter: false,
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
  canceledMark: DEFAULT_CANCELLED_MARK,
});

export class ThingsToolkitSettingsTab extends PluginSettingTab {
  private readonly toolkitPlugin: ThingsToolkitPlugin;

  constructor(app: App, plugin: ThingsToolkitPlugin) {
    super(app, plugin);
    this.toolkitPlugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem<EditableSettingKey>[] {
    const syncItems: SettingGroupItem<EditableSettingKey>[] = this.toolkitPlugin.isSyncSupported()
      ? [
          {
            name: "Sync status",
            render: (setting) => {
              this.configureResetLastSyncSetting(setting);
            },
          },
          {
            name: "Things access",
            desc: "Auto tries the Things database first, then uses AppleScript when macOS privacy blocks direct access.",
            control: {
              type: "dropdown",
              key: "thingsAccessMode",
              options: {
                auto: "Auto",
                applescript: "AppleScript",
                sqlite: "SQLite only",
              },
            },
          },
          {
            name: "macOS privacy status",
            render: (setting) => {
              this.configureThingsAccessStatusSetting(setting);
            },
          },
          {
            name: "Enable periodic syncing",
            control: {
              type: "toggle",
              key: "isSyncEnabled",
            },
          },
          {
            name: "Sync frequency",
            desc: "Number of seconds the plugin will wait before syncing again",
            control: {
              type: "number",
              key: "syncInterval",
              min: 60,
              step: 1,
            },
          },
          {
            name: "AppleScript fallback lookback",
            desc: `Days to repair when macOS blocks direct Things database access. The recent review window always uses at least ${MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS} days.`,
            control: {
              type: "number",
              key: "appleScriptFallbackLookbackDays",
              min: 1,
              step: 1,
            },
          },
        ]
      : [
          {
            name: "Sync unavailable",
            desc: "Things sync runs only in Obsidian for macOS. The plugin can stay enabled here so Obsidian Sync does not disable it on your Mac.",
          },
        ];

    return [
      {
        type: "group",
        heading: "Sync engine",
        items: syncItems,
      },
      {
        type: "group",
        heading: "Daily notes",
        items: [
          {
            name: "Section heading",
            desc: "Markdown heading to replace or append when adding Things items to a daily note",
            control: { type: "text", key: "sectionHeading" },
          },
          {
            name: "Include notes",
            desc: "Includes MD notes of a task into the synced Obsidian document",
            control: { type: "toggle", key: "doesSyncNoteBody" },
          },
          {
            name: "Include project",
            desc: "If the Things task belongs to a project, use project name as header instead of area",
            control: { type: "toggle", key: "doesSyncProject" },
          },
          {
            name: "Empty line before headings",
            desc: "When grouping tasks with headings by area or project, add an empty line before that heading",
            control: {
              type: "toggle",
              key: "doesAddNewlineBeforeHeadings",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Imported tags",
        items: [
          {
            name: "Tag prefix",
            desc: "Prefix added to Things tags when imported into Obsidian (e.g. #things/work)",
            control: { type: "text", key: "tagPrefix" },
          },
          {
            name: "Canceled mark",
            desc: "Mark character to use for canceled tasks",
            control: { type: "text", key: "canceledMark" },
          },
        ],
      },
      {
        type: "group",
        heading: "Review calendar",
        items: [
          {
            name: "Review window",
            desc: "Number of recent days to show and repair in the review calendar",
            control: {
              type: "number",
              key: "reviewWindowDays",
              min: 30,
              step: 1,
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    if (this.isEditableSettingKey(key)) {
      return this.toolkitPlugin.options[key];
    }

    return undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    switch (key) {
      case "thingsAccessMode":
        if (value === "auto" || value === "applescript" || value === "sqlite") {
          await this.toolkitPlugin.writeOptions({ thingsAccessMode: value });
          this.refresh();
        }
        return;
      case "sectionHeading":
        if (typeof value === "string") {
          await this.toolkitPlugin.writeOptions({
            sectionHeading: this.normalizeSectionHeading(value),
          });
        }
        return;
      case "tagPrefix":
      case "canceledMark":
        if (typeof value === "string") {
          await this.toolkitPlugin.writeOptions({ [key]: value });
        }
        return;
      case "doesAddNewlineBeforeHeadings":
      case "doesSyncNoteBody":
      case "doesSyncProject":
      case "isSyncEnabled":
        if (typeof value === "boolean") {
          await this.toolkitPlugin.writeOptions({ [key]: value });
        }
        return;
      case "syncInterval":
        await this.toolkitPlugin.writeOptions({
          syncInterval: this.normalizePositiveInteger(
            value,
            60,
            DEFAULT_SYNC_FREQUENCY_SECONDS
          ),
        });
        return;
      case "appleScriptFallbackLookbackDays":
        await this.toolkitPlugin.writeOptions({
          appleScriptFallbackLookbackDays: this.normalizePositiveInteger(
            value,
            1,
            DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS
          ),
        });
        return;
      case "reviewWindowDays":
        await this.toolkitPlugin.writeOptions({
          reviewWindowDays: this.normalizePositiveInteger(
            value,
            30,
            DEFAULT_REVIEW_WINDOW_DAYS
          ),
        });
    }
  }

  refresh(): void {
    if (refreshDeclarativeSettings(this)) {
      return;
    }

    this.renderLegacySettings();
  }

  display(): void {
    this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    this.containerEl.empty();

    new Setting(this.containerEl).setName("Sync engine").setHeading();
    if (this.toolkitPlugin.isSyncSupported()) {
      this.addResetLastSyncSetting();
      this.addThingsAccessModeSetting();
      this.addThingsAccessStatusSetting();
      this.addSyncEnabledSetting();
      this.addSyncIntervalSetting();
      this.addAppleScriptFallbackLookbackSetting();
    } else {
      this.addUnsupportedSyncSetting();
    }

    new Setting(this.containerEl).setName("Daily notes").setHeading();
    this.addSectionHeadingSetting();
    this.addDoesSyncNoteBodySetting();
    this.addDoesSyncProjectSetting();
    this.addDoesAddNewlineBeforeHeadingsSetting();

    new Setting(this.containerEl).setName("Imported tags").setHeading();
    this.addTagPrefixSetting();
    this.addCanceledMarkSetting();

    new Setting(this.containerEl).setName("Review calendar").setHeading();
    this.addReviewWindowDaysSetting();
  }

  private isEditableSettingKey(key: string): key is EditableSettingKey {
    return [
      "appleScriptFallbackLookbackDays",
      "canceledMark",
      "doesAddNewlineBeforeHeadings",
      "doesSyncNoteBody",
      "doesSyncProject",
      "isSyncEnabled",
      "reviewWindowDays",
      "sectionHeading",
      "syncInterval",
      "tagPrefix",
      "thingsAccessMode",
    ].includes(key);
  }

  private normalizePositiveInteger(
    value: unknown,
    minimum: number,
    fallback: number
  ): number {
    return Math.max(minimum, Math.floor(Number(value) || fallback));
  }

  addSectionHeadingSetting(): void {
    new Setting(this.containerEl)
      .setName("Section heading")
      .setDesc(
        "Markdown heading to replace or append when adding Things items to a daily note"
      )
      .addText((textfield) => {
        textfield.setValue(this.toolkitPlugin.options.sectionHeading);
        textfield.onChange((rawSectionHeading) => {
          const sectionHeading = this.normalizeSectionHeading(rawSectionHeading);
          void this.toolkitPlugin.writeOptions({ sectionHeading });
        });
      });
  }

  addReviewWindowDaysSetting(): void {
    new Setting(this.containerEl)
      .setName("Review window")
      .setDesc("Number of recent days to show and repair in the review calendar")
      .addText((textfield) => {
        textfield.setValue(String(this.toolkitPlugin.options.reviewWindowDays));
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (event: FocusEvent) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }

          const reviewWindowDays = Math.max(
            30,
            Math.floor(Number(target.value) || DEFAULT_REVIEW_WINDOW_DAYS)
          );

          textfield.setValue(String(reviewWindowDays));
          void this.toolkitPlugin.writeOptions({ reviewWindowDays });
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
        toggle.setValue(this.toolkitPlugin.options.isSyncEnabled);
        toggle.onChange((isSyncEnabled) => {
          void this.toolkitPlugin.writeOptions({ isSyncEnabled });
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

        dropdown.setValue(this.toolkitPlugin.options.thingsAccessMode);
        dropdown.onChange(async (value: string) => {
          const thingsAccessMode = value as ThingsAccessMode;
          await this.toolkitPlugin.writeOptions({ thingsAccessMode });
          this.refresh();
        });
      });
  }

  addThingsAccessStatusSetting(): void {
    this.configureThingsAccessStatusSetting(new Setting(this.containerEl));
  }

  private configureThingsAccessStatusSetting(setting: Setting): void {
    const accessStatus = this.toolkitPlugin.options.thingsAccessStatus;
    const statusText = accessStatus
      ? `${accessStatus.message} Checked ${moment
          .unix(accessStatus.updatedAt)
          .fromNow()}.`
      : "Not checked yet. Run Sync now to test Things access.";

    setting
      .setName("macOS privacy status")
      .setDesc(statusText)
      .addButton((button) => {
        button.setButtonText("Full Disk Access");
        button.onClick(() => {
          this.openSystemSettings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
          );
        });
      })
      .addButton((button) => {
        button.setButtonText("Automation");
        button.onClick(() => {
          this.openSystemSettings(
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
      .setDesc("Includes MD notes of a task into the synced Obsidian document")
      .addToggle((toggle) => {
        toggle.setValue(this.toolkitPlugin.options.doesSyncNoteBody);
        toggle.onChange((doesSyncNoteBody) => {
          void this.toolkitPlugin.writeOptions({ doesSyncNoteBody });
        });
      });
  }

  addDoesSyncProjectSetting(): void {
    new Setting(this.containerEl)
      .setName("Include project")
      .setDesc(
        "If the Things task belongs to a project, use project name as header instead of area"
      )
      .addToggle((toggle) => {
        toggle.setValue(this.toolkitPlugin.options.doesSyncProject);
        toggle.onChange((doesSyncProject) => {
          void this.toolkitPlugin.writeOptions({ doesSyncProject });
        });
      });
  }

  addSyncIntervalSetting(): void {
    new Setting(this.containerEl)
      .setName("Sync frequency")
      .setDesc("Number of seconds the plugin will wait before syncing again")
      .addText((textfield) => {
        textfield.setValue(String(this.toolkitPlugin.options.syncInterval));
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (event: FocusEvent) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }

          const syncInterval = Math.max(
            60,
            Math.floor(Number(target.value) || DEFAULT_SYNC_FREQUENCY_SECONDS)
          );

          textfield.setValue(String(syncInterval));
          void this.toolkitPlugin.writeOptions({ syncInterval });
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
        textfield.setValue(
          String(this.toolkitPlugin.options.appleScriptFallbackLookbackDays)
        );
        textfield.inputEl.type = "number";
        textfield.inputEl.onblur = (event: FocusEvent) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) {
            return;
          }

          const appleScriptFallbackLookbackDays = Math.max(
            1,
            Math.floor(
              Number(target.value) || DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS
            )
          );

          textfield.setValue(String(appleScriptFallbackLookbackDays));
          void this.toolkitPlugin.writeOptions({
            appleScriptFallbackLookbackDays,
          });
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
        textfield.setValue(this.toolkitPlugin.options.tagPrefix);
        textfield.onChange((tagPrefix) => {
          void this.toolkitPlugin.writeOptions({ tagPrefix });
        });
      });
  }

  addCanceledMarkSetting(): void {
    new Setting(this.containerEl)
      .setName("Canceled mark")
      .setDesc("Mark character to use for canceled tasks")
      .addText((textfield) => {
        textfield.setValue(this.toolkitPlugin.options.canceledMark);
        textfield.onChange((canceledMark) => {
          void this.toolkitPlugin.writeOptions({ canceledMark });
        });
      });
  }

  addDoesAddNewlineBeforeHeadingsSetting(): void {
    new Setting(this.containerEl)
      .setName("Empty line before headings")
      .setDesc(
        "When grouping tasks with headings by area or project, add an empty line before that heading"
      )
      .addToggle((toggle) => {
        toggle.setValue(
          this.toolkitPlugin.options.doesAddNewlineBeforeHeadings
        );
        toggle.onChange((doesAddNewlineBeforeHeadings) => {
          void this.toolkitPlugin.writeOptions({
            doesAddNewlineBeforeHeadings,
          });
        });
      });
  }

  addResetLastSyncSetting(): void {
    this.configureResetLastSyncSetting(new Setting(this.containerEl));
  }

  private configureResetLastSyncSetting(setting: Setting): void {
    const { latestSyncTime } = this.toolkitPlugin.options;
    const { syncStatus } = this.toolkitPlugin;
    const syncTime =
      latestSyncTime > 0
        ? moment.unix(this.toolkitPlugin.options.latestSyncTime).fromNow()
        : "Never";

    setting
      .setDesc(
        createFragment((el) => {
          el.appendText("Last sync: ");
          el.createSpan({ cls: "u-pop", text: syncTime });

          if (syncStatus.message) {
            el.createEl("br");
            el.appendText(syncStatus.message);
          }
        })
      )
      .addButton((button) => {
        button.setButtonText(syncStatus.isSyncing ? "Syncing..." : "Sync now");
        button.setClass("mod-cta");
        button.setDisabled(syncStatus.isSyncing);
        button.onClick(async () => {
          button.setDisabled(true);
          await this.toolkitPlugin.tryToSyncLogbook();
          this.refresh();
        });
      })
      .addButton((button) => {
        button.setButtonText("Reset sync history");
        button.setClass("mod-danger");
        button.setDisabled(syncStatus.isSyncing);
        button.onClick(() => {
          void this.toolkitPlugin.writeOptions({ latestSyncTime: 0 });
          this.refresh();
        });
      })
      .addExtraButton((component) => {
        component.setIcon("lucide-info");
        component.setTooltip(
          "Resetting sync history will rewrite the configured Things section in matching daily notes."
        );
      });
  }
}
