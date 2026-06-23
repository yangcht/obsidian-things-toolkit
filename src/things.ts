import { getMoment, type MomentLike } from "./moment";

import { THINGS_DB_PATH_START, THINGS_DB_PATH_END } from "./constants";
import {
  getChildProcessModule,
  getFsModule,
  getOsModule,
  getPathModule,
} from "./nodeUtils";
import { querySqliteDB } from "./sqlite";

export const TASK_FETCH_LIMIT = 1000;
export const DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
export const MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
const APPLESCRIPT_RECORD_SEPARATOR = "\x1e";
const STATUS_COMPLETED = "3";

export interface ISubTask {
  completed: boolean;
  title: string;
}

export interface ITask {
  uuid: string;
  title: string;
  notes: string;
  area?: string;
  project?: string;
  tags: string[];
  startDate: number;
  stopDate: number;
  cancelled: boolean;
  subtasks: ISubTask[];
}

export interface ITaskRecord {
  uuid: string;
  title?: string;
  notes: string;
  area?: string;
  project?: string;
  startDate: number;
  stopDate: number;
  status: string;
  tag?: string;
}

export interface IChecklistItemRecord {
  uuid: string;
  taskId: string;
  title: string;
  startDate: number;
  stopDate: number;
}

export type ThingsToolkitSource = "sqlite" | "applescript" | "daily-note";
export type ThingsAccessMode = "auto" | "sqlite" | "applescript";

export interface IThingsAccessStatus {
  message: string;
  source: "sqlite" | "applescript";
  sqliteBlocked: boolean;
  updatedAt: number;
}

export interface IThingsToolkitFetchResult {
  accessStatus: IThingsAccessStatus;
  taskRecords: ITaskRecord[];
  checklistRecords: IChecklistItemRecord[];
  source: ThingsToolkitSource;
  cutoffTime: number;
  isLimited: boolean;
  repairLookbackDays?: number;
}

interface IThingsAppleScriptRecord {
  id: string;
  name?: string;
  notes?: string;
  status?: string;
  tagNames?: string;
  creationDate?: string;
  completionDate?: string;
  cancellationDate?: string;
  area?: { name?: string };
  project?: { name?: string };
}

const STATUS_CANCELLED = 2;

class ThingsSqlitePrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThingsSqlitePrivacyError";
  }
}

function getThingsSqlitePath(): string {
  const os = getOsModule();
  const fs = getFsModule();
  const path = getPathModule();
  // Info on how to find the Things db file here:
  // https://culturedcode.com/things/support/articles/2982272/
  const baseDir = THINGS_DB_PATH_START.replace("~", os.homedir());
  let dataFiles: string[];
  try {
    dataFiles = fs.readdirSync(baseDir);
  } catch (err) {
    if (isFileAccessDeniedError(err)) {
      throw new ThingsSqlitePrivacyError(
        "macOS privacy is blocking direct access to the Things database"
      );
    }
    throw err;
  }

  const dataPath = dataFiles.find((file) => file.startsWith("ThingsData")) ?? "";
  const dbPath = dataPath ? path.join(baseDir, dataPath, THINGS_DB_PATH_END) : "";

  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error("Things database not found");
  }

  return dbPath;
}

function isFileAccessDeniedError(err: unknown): boolean {
  const error =
    err && typeof err === "object"
      ? (err as { code?: string; message?: string })
      : undefined;
  return (
    error?.code === "EPERM" ||
    error?.code === "EACCES" ||
    String(error?.message || "").includes("operation not permitted")
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildAccessStatus(
  source: "sqlite" | "applescript",
  message: string,
  sqliteBlocked: boolean
): IThingsAccessStatus {
  return {
    message,
    source,
    sqliteBlocked,
    updatedAt: getMoment()().unix(),
  };
}

function getRepairCutoff(
  latestSyncTime: number,
  repairLookbackDays: number
): MomentLike {
  const moment = getMoment();
  const incrementalCutoff = moment.unix(latestSyncTime).startOf("day");
  const repairCutoff = moment()
    .subtract(Math.max(1, Number(repairLookbackDays) || 1), "days")
    .startOf("day");

  if (latestSyncTime > 0 && incrementalCutoff.isBefore(repairCutoff)) {
    return incrementalCutoff;
  }
  return repairCutoff;
}

function getLastStopDate<T extends { stopDate: number }>(
  records: T[]
): number | null {
  const recordsWithStopDate = records.filter((record) => record.stopDate);
  return recordsWithStopDate[recordsWithStopDate.length - 1]?.stopDate ?? null;
}

function chunkToString(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdOut: string[] = [];
    const stdErr: string[] = [];
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      if (err) {
        reject(err);
      } else {
        resolve(stdOut.join(""));
      }
    };

    const childProcess = getChildProcessModule();
    const spawned = childProcess.spawn("osascript", ["-e", script]);
    spawned.stdout.on("data", (chunk: unknown) => stdOut.push(chunkToString(chunk)));
    spawned.stderr.on("data", (chunk: unknown) => stdErr.push(chunkToString(chunk)));
    spawned.on("error", finish);
    spawned.on("close", (code: number | null) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(stdErr.join("")));
      }
    });
  });
}

function getAppleScriptCutoff(
  latestSyncTime: number,
  fallbackLookbackDays: number,
  repairLookbackDays: number
): MomentLike {
  const moment = getMoment();
  const configuredLookbackDays = Math.max(
    1,
    Number(fallbackLookbackDays) || DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS
  );
  const lookbackDays = Math.max(
    configuredLookbackDays,
    repairLookbackDays,
    MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS
  );
  const lookbackCutoff = getRepairCutoff(latestSyncTime, lookbackDays);

  if (latestSyncTime > 0) {
    const incrementalCutoff = moment.unix(latestSyncTime).startOf("day");
    if (lookbackCutoff.isBefore(incrementalCutoff)) {
      console.debug(
        `[Things Toolkit] repairing the last ${lookbackDays} days from Things AppleScript.`
      );
      return lookbackCutoff;
    }
    return incrementalCutoff;
  }

  console.warn(
    `[Things Toolkit] SQLite is unavailable. Falling back to the last ${lookbackDays} days from Things AppleScript instead of scanning the full Logbook.`
  );
  return lookbackCutoff;
}

function buildThingsToolkitAppleScript(cutoff: MomentLike): string {
  return `
set cutoff to current date
set year of cutoff to ${cutoff.year()}
set month of cutoff to ${cutoff.month() + 1}
set day of cutoff to ${cutoff.date()}
set time of cutoff to ${cutoff.diff(cutoff.clone().startOf("day"), "seconds")}
set sep to ASCII character 30
set out to ""
tell application "Things3"
  set completedItems to to dos of list "Logbook" whose status is completed and completion date > cutoff
  repeat with taskItem in completedItems
    set out to out & (_private_experimental_ json of taskItem) & sep
  end repeat
  set canceledItems to to dos of list "Logbook" whose status is canceled and cancellation date > cutoff
  repeat with taskItem in canceledItems
    set out to out & (_private_experimental_ json of taskItem) & sep
  end repeat
end tell
return out
`;
}

function toUnixTime(dateString?: string): number {
  if (!dateString) {
    return 0;
  }

  return Math.floor(new Date(dateString).getTime() / 1000);
}

function buildTaskRecordsFromAppleScriptJson(
  records: IThingsAppleScriptRecord[]
): ITaskRecord[] {
  return records.flatMap((record) => {
    const isCancelled = record.status === "canceled";
    const stopDate = toUnixTime(
      isCancelled ? record.cancellationDate : record.completionDate
    );
    const tags = (record.tagNames || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => !!tag);
    const task: Omit<ITaskRecord, "tag"> = {
      uuid: record.id,
      title: record.name,
      notes: record.notes || "",
      area: record.area?.name,
      project: record.project?.name,
      startDate: toUnixTime(record.creationDate),
      stopDate,
      status: isCancelled ? String(STATUS_CANCELLED) : STATUS_COMPLETED,
    };

    if (tags.length === 0) {
      return [{ ...task }];
    }

    return tags.map((tag) => ({ ...task, tag }));
  });
}

async function getTasksFromThingsAppleScript(
  latestSyncTime: number,
  fallbackLookbackDays: number,
  repairLookbackDays: number,
  accessStatus: IThingsAccessStatus
): Promise<IThingsToolkitFetchResult> {
  const moment = getMoment();
  const cutoff = getAppleScriptCutoff(
    latestSyncTime,
    fallbackLookbackDays,
    repairLookbackDays
  );
  console.debug(
    `[Things Toolkit] fetching tasks from Things AppleScript after ${cutoff.format()}...`
  );

  const output = await runAppleScript(buildThingsToolkitAppleScript(cutoff));
  const records = output
    .split(APPLESCRIPT_RECORD_SEPARATOR)
    .map((line) => line.trim())
    .filter((line) => !!line)
    .map((line) => JSON.parse(line) as IThingsAppleScriptRecord);

  const taskRecords = buildTaskRecordsFromAppleScriptJson(records);
  console.debug(
    `[Things Toolkit] fetched ${records.length} tasks from Things AppleScript`
  );
  return {
    accessStatus,
    taskRecords,
    checklistRecords: [],
    source: "applescript",
    cutoffTime: cutoff.unix(),
    isLimited: latestSyncTime === 0,
    repairLookbackDays: moment().startOf("day").diff(cutoff, "days"),
  };
}

export function buildTasksFromSQLRecords(
  taskRecords: ITaskRecord[],
  checklistRecords: IChecklistItemRecord[]
): ITask[] {
  const tasks: Record<string, ITask> = {};
  taskRecords.forEach(({ tag, ...task }) => {
    const id = task.uuid;
    const { status, title, ...other } = task;

    if (tasks[id]) {
      if (tag && !tasks[id].tags.includes(tag)) {
        tasks[id].tags.push(tag);
      }
    } else {
      tasks[id] = {
        ...other,
        cancelled: STATUS_CANCELLED === Number.parseInt(status),
        title: (title || "").trimEnd(),
        subtasks: [],
        tags: tag ? [tag] : [],
      };
    }
  });

  checklistRecords.forEach(({ taskId, title, stopDate }) => {
    const task = tasks[taskId];
    const subtaskTitle = (title || "").trimEnd();
    if (!subtaskTitle) {
      return;
    }

    const subtask = {
      completed: !!stopDate,
      title: subtaskTitle,
    };

    // checklist item might be completed before task
    if (task) {
      if (task.subtasks) {
        task.subtasks.push(subtask);
      } else {
        task.subtasks = [subtask];
      }
    }
  });

  return Object.values(tasks).sort((a, b) => {
    const stopDateDiff = b.stopDate - a.stopDate;
    if (stopDateDiff !== 0) {
      return stopDateDiff;
    }
    return a.uuid.localeCompare(b.uuid);
  });
}

async function getTasksFromThingsDb(
  latestSyncTime: number
): Promise<ITaskRecord[]> {
  return querySqliteDB<ITaskRecord>(
    getThingsSqlitePath(),
    `SELECT
        TMTask.uuid as uuid,
        TMTask.title as title,
        TMTask.notes as notes,
        TMTask.startDate as startDate,
        TMTask.stopDate as stopDate,
        TMTask.status as status,
        TMArea.title as area,
        TMTag.title as tag,
        TMProject.title as project
    FROM
        TMTask
    LEFT JOIN TMTaskTag
        ON TMTaskTag.tasks = TMTask.uuid
    LEFT JOIN TMTag
        ON TMTag.uuid = TMTaskTag.tags
    LEFT JOIN TMArea
        ON TMTask.area = TMArea.uuid
    LEFT JOIN TMTask TMProject
        ON TMProject.uuid = TMTask.project
    WHERE
        TMTask.trashed = 0
        AND TMTask.stopDate IS NOT NULL
        AND TMTask.stopDate > ${latestSyncTime}
    ORDER BY
        TMTask.stopDate
    LIMIT ${TASK_FETCH_LIMIT}
        `
  );
}

async function getChecklistItemsThingsDb(
  latestSyncTime: number
): Promise<IChecklistItemRecord[]> {
  return querySqliteDB<IChecklistItemRecord>(
    getThingsSqlitePath(),
    `SELECT
        task as taskId,
        title as title,
        stopDate as stopDate
    FROM
        TMChecklistItem
    WHERE
        stopDate > ${latestSyncTime}
        AND title IS NOT ""
    ORDER BY
        stopDate
    LIMIT ${TASK_FETCH_LIMIT}
        `
  );
}

async function getTasksFromThingsSqlite(
  latestSyncTime: number
): Promise<ITaskRecord[]> {
  const moment = getMoment();
  const taskRecords: ITaskRecord[] = [];
  let isSyncCompleted = false;
  let stopTime = moment.unix(latestSyncTime).startOf("day").unix();

  while (!isSyncCompleted) {
    console.debug("[Things Toolkit] fetching tasks from sqlite db...");

    const batch = await getTasksFromThingsDb(stopTime);

    isSyncCompleted = batch.length < TASK_FETCH_LIMIT;
    const lastStopDate = getLastStopDate(batch);
    if (lastStopDate) {
      stopTime = lastStopDate;
    }

    taskRecords.push(...batch);
    console.debug(
      `[Things Toolkit] fetched ${batch.length} tasks from sqlite db`
    );
  }

  return taskRecords;
}

async function getChecklistItemsFromThingsSqlite(
  latestSyncTime: number
): Promise<IChecklistItemRecord[]> {
  const checklistItems: IChecklistItemRecord[] = [];
  let isSyncCompleted = false;
  let stopTime = latestSyncTime;

  while (!isSyncCompleted) {
    console.debug(
      "[Things Toolkit] fetching checklist items from sqlite db..."
    );

    const batch = await getChecklistItemsThingsDb(stopTime);

    isSyncCompleted = batch.length < TASK_FETCH_LIMIT;
    const lastStopDate = getLastStopDate(batch);
    if (lastStopDate) {
      stopTime = lastStopDate;
    }

    checklistItems.push(...batch);
    console.debug(
      `[Things Toolkit] fetched ${batch.length} checklist items from sqlite db`
    );
  }

  return checklistItems;
}

export async function fetchThingsToolkit(
  latestSyncTime: number,
  fallbackLookbackDays: number,
  accessMode: ThingsAccessMode,
  repairLookbackDays: number
): Promise<IThingsToolkitFetchResult> {
  const moment = getMoment();
  const cutoff = getRepairCutoff(latestSyncTime, repairLookbackDays);
  const cutoffTime = cutoff.unix();

  if (accessMode === "applescript") {
    return getTasksFromThingsAppleScript(
      latestSyncTime,
      fallbackLookbackDays,
      repairLookbackDays,
      buildAccessStatus(
        "applescript",
        "Using Things AppleScript. Direct database access is disabled in settings.",
        false
      )
    );
  }

  try {
    const taskRecords = await getTasksFromThingsSqlite(cutoffTime);
    const checklistRecords = await getChecklistItemsFromThingsSqlite(cutoffTime);

    return {
      accessStatus: buildAccessStatus(
        "sqlite",
        "Using direct Things database access.",
        false
      ),
      taskRecords,
      checklistRecords,
      source: "sqlite",
      cutoffTime,
      isLimited: false,
      repairLookbackDays: moment().startOf("day").diff(cutoff, "days"),
    };
  } catch (err) {
    if (accessMode === "sqlite") {
      throw new Error(`Things SQLite access failed: ${getErrorMessage(err)}`, {
        cause: err,
      });
    }

    const sqliteBlocked =
      err instanceof ThingsSqlitePrivacyError || isFileAccessDeniedError(err);
    const message = sqliteBlocked
      ? "macOS privacy is blocking direct access to the Things database. Using Things AppleScript instead."
      : `Direct Things database access is unavailable. Using Things AppleScript instead. (${getErrorMessage(err)})`;

    console.warn(
      "[Things Toolkit] Things SQLite DB is unavailable; falling back to Things AppleScript",
      err
    );
    console.warn(
      "[Things Toolkit] Checklist items are skipped because Things AppleScript does not expose them."
    );

    try {
      return await getTasksFromThingsAppleScript(
        latestSyncTime,
        fallbackLookbackDays,
        repairLookbackDays,
        buildAccessStatus("applescript", message, sqliteBlocked)
      );
    } catch (appleScriptErr) {
      throw new Error(
        `Things AppleScript access failed after SQLite was unavailable: ${getErrorMessage(appleScriptErr)}`,
        { cause: appleScriptErr }
      );
    }
  }
}
