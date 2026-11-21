import { getMoment, type MomentLike } from "./moment";

import { THINGS_DB_PATH_START, THINGS_DB_PATH_END } from "./constants";
import {
  getChildProcessModule,
  getFsModule,
  getOsModule,
  getPathModule,
  type FsModuleLike,
  type OsModuleLike,
  type PathModuleLike,
} from "./nodeUtils";
import { decodeStreamChunk, querySqliteDB } from "./sqlite";

export const TASK_FETCH_LIMIT = 1000;
export const CHECKLIST_TASK_BATCH_SIZE = 200;
export const DEFAULT_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
export const MIN_APPLESCRIPT_FALLBACK_LOOKBACK_DAYS = 365;
const APPLESCRIPT_RECORD_SEPARATOR = "\x1e";
const STATUS_COMPLETED = "3";

export type SqliteQueryFn = <T>(dbPath: string, query: string) => Promise<T[]>;

export interface ISqliteFetchOptions {
  batchLimit?: number;
  dbPath?: string;
  querySqlite?: SqliteQueryFn;
}

export interface IChecklistFetchOptions {
  dbPath?: string;
  querySqlite?: SqliteQueryFn;
  taskBatchSize?: number;
}

interface ITaskPageCursor {
  stopDate: number;
  uuid: string;
}

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

export function findThingsSqlitePath(deps?: {
  fs?: FsModuleLike;
  os?: OsModuleLike;
  path?: PathModuleLike;
}): string {
  const os = deps?.os ?? getOsModule();
  const fs = deps?.fs ?? getFsModule();
  const path = deps?.path ?? getPathModule();
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

  const candidatePaths = dataFiles
    .filter((file) => file.startsWith("ThingsData"))
    .map((dataPath) => path.join(baseDir, dataPath, THINGS_DB_PATH_END))
    .filter((candidatePath) => fs.existsSync(candidatePath));

  if (candidatePaths.length === 0) {
    throw new Error("Things database not found");
  }

  if (candidatePaths.length === 1 || typeof fs.statSync !== "function") {
    return candidatePaths[0];
  }

  const statSync = fs.statSync.bind(fs);
  return candidatePaths
    .map((candidatePath) => {
      try {
        return { candidatePath, mtimeMs: statSync(candidatePath).mtimeMs };
      } catch {
        return { candidatePath, mtimeMs: -1 };
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0].candidatePath;
}

export function isFileAccessDeniedError(err: unknown): boolean {
  const error =
    err && typeof err === "object"
      ? (err as { code?: string; message?: string })
      : undefined;
  return (
    error?.code === "EPERM" ||
    error?.code === "EACCES" ||
    /operation not permitted|permission denied|authorization denied/i.test(
      String(error?.message || "")
    )
  );
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function getCalendarDayDiff(nowStartOfDay: MomentLike, cutoff: MomentLike): number {
  return Math.max(0, Math.round(nowStartOfDay.diff(cutoff, "days", true)));
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

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdOut: string[] = [];
    const stdErr: string[] = [];
    const stdOutDecoder = new TextDecoder("utf-8");
    const stdErrDecoder = new TextDecoder("utf-8");
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      const trailingOut = stdOutDecoder.decode();
      if (trailingOut) {
        stdOut.push(trailingOut);
      }
      const trailingErr = stdErrDecoder.decode();
      if (trailingErr) {
        stdErr.push(trailingErr);
      }

      if (err) {
        reject(err);
      } else {
        resolve(stdOut.join(""));
      }
    };

    const childProcess = getChildProcessModule();
    const spawned = childProcess.spawn("osascript", ["-e", script]);
    spawned.stdout.on("data", (chunk: unknown) =>
      stdOut.push(decodeStreamChunk(stdOutDecoder, chunk))
    );
    spawned.stderr.on("data", (chunk: unknown) =>
      stdErr.push(decodeStreamChunk(stdErrDecoder, chunk))
    );
    spawned.on("error", finish);
    spawned.on("close", (code: number | null) => {
      if (code === 0) {
        finish();
      } else {
        const trailingErr = stdErrDecoder.decode();
        if (trailingErr) {
          stdErr.push(trailingErr);
        }
        const message =
          stdErr.join("").trim() || `osascript exited with code ${String(code)}`;
        finish(new Error(message));
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

export function buildThingsToolkitAppleScript(cutoff: MomentLike): string {
  return `
set cutoff to current date
set day of cutoff to 1
set year of cutoff to ${cutoff.year()}
set month of cutoff to ${cutoff.month() + 1}
set day of cutoff to ${cutoff.date()}
set time of cutoff to ${cutoff.diff(cutoff.clone().startOf("day"), "seconds")}
set sep to ASCII character 30
set out to ""
tell application "Things3"
  set completedItems to to dos of list "Logbook" whose status is completed and completion date >= cutoff
  repeat with taskItem in completedItems
    set out to out & (_private_experimental_ json of taskItem) & sep
  end repeat
  set canceledItems to to dos of list "Logbook" whose status is canceled and cancellation date >= cutoff
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

  const timestampMs = new Date(dateString).getTime();
  return Number.isFinite(timestampMs) ? Math.floor(timestampMs / 1000) : 0;
}

export function buildTaskRecordsFromAppleScriptJson(
  records: IThingsAppleScriptRecord[]
): ITaskRecord[] {
  return records.flatMap((record) => {
    if (!record || typeof record.id !== "string" || !record.id) {
      return [];
    }

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
    repairLookbackDays: getCalendarDayDiff(moment().startOf("day"), cutoff),
  };
}

export function buildTasksFromSQLRecords(
  taskRecords: ITaskRecord[],
  checklistRecords: IChecklistItemRecord[]
): ITask[] {
  const tasks = new Map<string, ITask>();
  taskRecords.forEach(({ tag, ...task }) => {
    const id = task.uuid;
    if (!id) {
      return;
    }

    const { status, title, startDate, stopDate, area, project, notes } = task;
    const existing = tasks.get(id);

    if (existing) {
      if (tag && !existing.tags.includes(tag)) {
        existing.tags.push(tag);
      }
    } else {
      tasks.set(id, {
        uuid: id,
        notes: notes || "",
        area: area || undefined,
        project: project || undefined,
        startDate: toFiniteNumber(startDate),
        stopDate: toFiniteNumber(stopDate),
        cancelled: STATUS_CANCELLED === Number.parseInt(String(status), 10),
        title: (title || "").trimEnd(),
        subtasks: [],
        tags: tag ? [tag] : [],
      });
    }
  });

  const seenChecklistUuids = new Map<string, Set<string>>();

  checklistRecords.forEach(({ uuid, taskId, title, stopDate }) => {
    const task = tasks.get(taskId);
    const subtaskTitle = (title || "").trimEnd();
    if (!task || !subtaskTitle) {
      return;
    }

    if (uuid) {
      let seenForTask = seenChecklistUuids.get(taskId);
      if (!seenForTask) {
        seenForTask = new Set<string>();
        seenChecklistUuids.set(taskId, seenForTask);
      }
      if (seenForTask.has(uuid)) {
        return;
      }
      seenForTask.add(uuid);
    }

    const subtask = {
      completed: toFiniteNumber(stopDate) > 0,
      title: subtaskTitle,
    };

    task.subtasks.push(subtask);
  });

  return Array.from(tasks.values()).sort((a, b) => {
    const stopDateDiff = b.stopDate - a.stopDate;
    if (stopDateDiff !== 0) {
      return stopDateDiff;
    }
    return a.uuid.localeCompare(b.uuid);
  });
}

function buildTasksPageQuery(
  cutoffTime: number,
  batchLimit: number,
  cursor: ITaskPageCursor | null
): string {
  const safeCutoff = toFiniteNumber(cutoffTime);
  const safeLimit = Math.max(1, Math.floor(batchLimit));

  const cursorPredicate = cursor
    ? `(
        TMTask.stopDate > COALESCE(
          (SELECT stopDate FROM TMTask WHERE uuid = '${escapeSqlString(cursor.uuid)}'),
          ${toFiniteNumber(cursor.stopDate)}
        )
        OR (
          TMTask.stopDate = COALESCE(
            (SELECT stopDate FROM TMTask WHERE uuid = '${escapeSqlString(cursor.uuid)}'),
            ${toFiniteNumber(cursor.stopDate)}
          )
          AND TMTask.uuid > '${escapeSqlString(cursor.uuid)}'
        )
      )`
    : `TMTask.stopDate >= ${safeCutoff}`;

  return `WITH paged_tasks AS (
        SELECT
            TMTask.uuid as uuid,
            TMTask.title as title,
            TMTask.notes as notes,
            TMTask.startDate as startDate,
            TMTask.stopDate as stopDate,
            TMTask.status as status,
            TMTask.area as area,
            TMTask.project as project,
            TMTask.heading as heading
        FROM
            TMTask
        WHERE
            TMTask.trashed = 0
            AND TMTask.uuid IS NOT NULL
            AND TMTask.stopDate IS NOT NULL
            AND ${cursorPredicate}
        ORDER BY
            TMTask.stopDate ASC,
            TMTask.uuid ASC
        LIMIT ${safeLimit}
    )
    SELECT
        paged_tasks.uuid as uuid,
        paged_tasks.title as title,
        paged_tasks.notes as notes,
        paged_tasks.startDate as startDate,
        paged_tasks.stopDate as stopDate,
        paged_tasks.status as status,
        TMArea.title as area,
        TMTag.title as tag,
        TMProject.title as project
    FROM
        paged_tasks
    LEFT JOIN TMTaskTag
        ON TMTaskTag.tasks = paged_tasks.uuid
    LEFT JOIN TMTag
        ON TMTag.uuid = TMTaskTag.tags
    LEFT JOIN TMTask TMHeading
        ON TMHeading.uuid = paged_tasks.heading
    LEFT JOIN TMTask TMProject
        ON TMProject.uuid = COALESCE(paged_tasks.project, TMHeading.project)
    LEFT JOIN TMArea
        ON TMArea.uuid = COALESCE(paged_tasks.area, TMProject.area)
    ORDER BY
        paged_tasks.stopDate ASC,
        paged_tasks.uuid ASC,
        TMTag.title ASC`;
}

function normalizeRawTaskRecord(raw: ITaskRecord): ITaskRecord {
  return {
    uuid: String(raw.uuid ?? ""),
    title: raw.title ?? "",
    notes: raw.notes ?? "",
    area: raw.area || undefined,
    project: raw.project || undefined,
    startDate: toFiniteNumber(raw.startDate),
    stopDate: toFiniteNumber(raw.stopDate),
    status: String(raw.status ?? ""),
    tag: raw.tag || undefined,
  };
}

function normalizeRawChecklistRecord(
  raw: IChecklistItemRecord
): IChecklistItemRecord {
  return {
    uuid: String(raw.uuid ?? ""),
    taskId: String(raw.taskId ?? ""),
    title: String(raw.title ?? ""),
    startDate: toFiniteNumber(raw.startDate),
    stopDate: toFiniteNumber(raw.stopDate),
  };
}

export async function getTasksFromThingsSqlite(
  cutoffTime: number,
  options: ISqliteFetchOptions = {}
): Promise<ITaskRecord[]> {
  const dbPath = options.dbPath ?? findThingsSqlitePath();
  const batchLimit = Math.max(1, Math.floor(options.batchLimit ?? TASK_FETCH_LIMIT));
  const querySqlite: SqliteQueryFn = options.querySqlite ?? querySqliteDB;
  const taskRecords: ITaskRecord[] = [];
  let cursor: ITaskPageCursor | null = null;

  for (;;) {
    console.debug("[Things Toolkit] fetching tasks from sqlite db...");

    const rawBatch: ITaskRecord[] = await querySqlite<ITaskRecord>(
      dbPath,
      buildTasksPageQuery(cutoffTime, batchLimit, cursor)
    );
    const batch: ITaskRecord[] = rawBatch.map(normalizeRawTaskRecord);
    const batchTaskUuids = new Set<string>();
    let lastCursor: ITaskPageCursor | null = null;

    for (const record of batch) {
      if (record.uuid) {
        batchTaskUuids.add(record.uuid);
        lastCursor = { stopDate: record.stopDate, uuid: record.uuid };
      }
    }

    taskRecords.push(...batch);
    console.debug(
      `[Things Toolkit] fetched ${batchTaskUuids.size} tasks (${batch.length} rows) from sqlite db`
    );

    if (
      batchTaskUuids.size < batchLimit ||
      !lastCursor ||
      (cursor && lastCursor.uuid === cursor.uuid)
    ) {
      break;
    }

    cursor = lastCursor;
  }

  return taskRecords;
}

export async function getChecklistItemsFromThingsSqlite(
  taskUuids: string[],
  options: IChecklistFetchOptions = {}
): Promise<IChecklistItemRecord[]> {
  const uniqueTaskUuids = Array.from(new Set(taskUuids.filter(Boolean)));
  if (uniqueTaskUuids.length === 0) {
    return [];
  }

  const dbPath = options.dbPath ?? findThingsSqlitePath();
  const taskBatchSize = Math.max(
    1,
    Math.floor(options.taskBatchSize ?? CHECKLIST_TASK_BATCH_SIZE)
  );
  const querySqlite: SqliteQueryFn = options.querySqlite ?? querySqliteDB;
  const checklistItems: IChecklistItemRecord[] = [];

  for (let offset = 0; offset < uniqueTaskUuids.length; offset += taskBatchSize) {
    const chunk = uniqueTaskUuids.slice(offset, offset + taskBatchSize);
    const inClause = chunk
      .map((uuid) => `'${escapeSqlString(uuid)}'`)
      .join(", ");

    console.debug(
      "[Things Toolkit] fetching checklist items from sqlite db..."
    );

    const rawBatch = await querySqlite<IChecklistItemRecord>(
      dbPath,
      `SELECT
          TMChecklistItem.uuid as uuid,
          TMChecklistItem.task as taskId,
          TMChecklistItem.title as title,
          TMChecklistItem.stopDate as stopDate
      FROM
          TMChecklistItem
      WHERE
          TMChecklistItem.task IN (${inClause})
          AND TMChecklistItem.title IS NOT NULL
          AND TRIM(TMChecklistItem.title) != ''
      ORDER BY
          TMChecklistItem.task ASC,
          TMChecklistItem."index" ASC,
          TMChecklistItem.uuid ASC`
    );

    const batch = rawBatch.map(normalizeRawChecklistRecord);
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
    const dbPath = findThingsSqlitePath();
    const taskRecords = await getTasksFromThingsSqlite(cutoffTime, { dbPath });
    const taskUuids = Array.from(
      new Set(taskRecords.map((record) => record.uuid).filter(Boolean))
    );
    const checklistRecords = await getChecklistItemsFromThingsSqlite(taskUuids, {
      dbPath,
    });

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
      repairLookbackDays: getCalendarDayDiff(moment().startOf("day"), cutoff),
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
