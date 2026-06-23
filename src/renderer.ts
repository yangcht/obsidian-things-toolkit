import type { App } from "obsidian";
import type { ISettings } from "./settings";
import type { ISubTask, ITask } from "./things";
import { getHeadingLevel, getTab, groupBy, toHeading } from "./textUtils";

interface VaultConfigReader {
  getConfig(key: "useTab"): boolean;
  getConfig(key: "tabSize"): number;
}

function getVaultConfig(app: App): VaultConfigReader {
  return app.vault as unknown as VaultConfigReader;
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
    const tab = getTab(vault.getConfig("useTab"), vault.getConfig("tabSize"));
    const prefix = this.settings.tagPrefix;

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

    const taskTitle = `[${task.title}](things:///show?id=${task.uuid}) ${tags}`.trimEnd();

    const notes = this.settings.doesSyncNoteBody
      ? String(task.notes || "")
          .trimEnd()
          .split("\n")
          .filter((line) => !!line)
          .map((noteLine) => `${tab}${noteLine}`)
      : [];

    return [
      `- [${task.cancelled ? this.settings.canceledMark : "x"}] ${taskTitle}`,
      ...notes,
      ...task.subtasks.map(
        (subtask: ISubTask) =>
          `${tab}- [${subtask.completed ? "x" : " "}] ${subtask.title}`
      ),
    ]
      .filter((line) => !!line)
      .join("\n");
  }

  public render(tasks: ITask[]): string {
    const { sectionHeading, doesSyncProject, doesAddNewlineBeforeHeadings } = this.settings;
    const headings = groupBy<ITask>(
      tasks,
      (task) => (doesSyncProject ? task.project : undefined) || task.area || ""
    );
    const headingLevel = getHeadingLevel(sectionHeading) ?? 2;

    const output = [sectionHeading];
    Object.entries(headings).forEach(([heading, groupedTasks]) => {
      if (heading !== "") {
        output.push(
          toHeading(heading, headingLevel + 1, doesAddNewlineBeforeHeadings)
        );
      }
      output.push(...groupedTasks.map((task) => this.renderTask(task)));
    });

    return output.join("\n");
  }
}
