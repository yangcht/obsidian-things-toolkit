import type { App } from "obsidian";
import type { ISettings } from "./settings";
import { DEFAULT_CANCELLED_MARK } from "./settingsUtils";
import type { ISubTask, ITask } from "./things";
import { getHeadingLevel, getTab, groupBy, toHeading } from "./textUtils";

interface VaultConfigReader {
  getConfig?: {
    (key: "useTab"): boolean | undefined;
    (key: "tabSize"): number | undefined;
  };
}

function getVaultConfig(app: App): VaultConfigReader {
  return app.vault as unknown as VaultConfigReader;
}

function sanitizeSingleLineText(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").trimEnd();
}

function escapeMarkdownLinkText(value: string): string {
  return sanitizeSingleLineText(value).replace(/([[\]])/g, "\\$1");
}

export class ToolkitRenderer {
  private app: App;
  private settings: ISettings;

  constructor(app: App, settings: ISettings) {
    this.app = app;
    this.settings = settings;
    this.renderTask = this.renderTask.bind(this);
  }

  renderTask(task: ITask): string {
    const vault = getVaultConfig(this.app);
    const useTab =
      typeof vault?.getConfig === "function" ? vault.getConfig("useTab") : undefined;
    const tabSize =
      typeof vault?.getConfig === "function" ? vault.getConfig("tabSize") : undefined;
    const tab = getTab(useTab, tabSize);
    const prefix = (this.settings.tagPrefix || "").replace(/^#+/, "");
    const canceledMark = this.settings.canceledMark || DEFAULT_CANCELLED_MARK;

    const tags = Array.from(
      new Set(
        task.tags
          .filter((tag) => !!tag)
          .map((tag) => tag.replace(/\s+/g, "-").toLowerCase())
          .sort()
      )
    )
      .map((tag) => `#${prefix}${tag}`)
      .join(" ");

    const safeTitle = escapeMarkdownLinkText(task.title || "");
    const taskTitle = `[${safeTitle}](things:///show?id=${task.uuid}) ${tags}`.trimEnd();

    const notes = this.settings.doesSyncNoteBody
      ? String(task.notes || "")
          .replace(/\r\n?/g, "\n")
          .trimEnd()
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((noteLine) => `${tab}${noteLine}`)
      : [];

    return [
      `- [${task.cancelled ? canceledMark : "x"}] ${taskTitle}`,
      ...notes,
      ...task.subtasks.map(
        (subtask: ISubTask) =>
          `${tab}- [${subtask.completed ? "x" : " "}] ${sanitizeSingleLineText(subtask.title)}`
      ),
    ]
      .filter((line) => !!line)
      .join("\n");
  }

  public render(tasks: ITask[]): string {
    const { sectionHeading, doesSyncProject, doesAddNewlineBeforeHeadings } = this.settings;
    const headings = groupBy<ITask>(
      tasks,
      (task) =>
        sanitizeSingleLineText(
          (doesSyncProject ? task.project : undefined) || task.area || ""
        )
    );
    const headingLevel = getHeadingLevel(sectionHeading) ?? 2;

    const output = [sectionHeading];
    // Render uncategorized tasks first so they stay directly under the main
    // section heading instead of falling under an earlier Area/Project heading.
    const uncategorizedTasks = headings[""];
    if (uncategorizedTasks) {
      output.push(...uncategorizedTasks.map((task) => this.renderTask(task)));
    }

    Object.entries(headings).forEach(([heading, groupedTasks]) => {
      if (heading === "") {
        return;
      }
      output.push(
        toHeading(
          heading,
          Math.min(6, headingLevel + 1),
          doesAddNewlineBeforeHeadings
        )
      );
      output.push(...groupedTasks.map((task) => this.renderTask(task)));
    });

    return output.join("\n");
  }
}
