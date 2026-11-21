import assert from "node:assert/strict";
import * as cp from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { rollup } from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

import type { ChildProcessLike, ChildProcessModuleLike } from "../src/nodeUtils";
import type { MomentLike } from "../src/moment";

const bundle = await rollup({
  input: "src/things.ts",
  external: ["child_process", "fs", "os", "path"],
  plugins: [
    {
      name: "obsidian-moment-stub",
      resolveId: (id) => (id === "obsidian" ? id : null),
      load: (id) => (id === "obsidian" ? "export const moment = null;" : null),
    },
    typescript({
      compilerOptions: { inlineSourceMap: false, inlineSources: false },
    }),
    resolve({ browser: true }),
    commonjs(),
  ],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();

const thingsModule = (await import(
  `data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`
)) as typeof import("../src/things");

const sqliteBundle = await rollup({
  input: "src/sqlite.ts",
  external: ["child_process", "fs", "os", "path"],
  plugins: [
    typescript({
      compilerOptions: { inlineSourceMap: false, inlineSources: false },
    }),
    resolve({ browser: true }),
    commonjs(),
  ],
});
const { output: sqliteOutput } = await sqliteBundle.generate({ format: "es" });
await sqliteBundle.close();

const sqliteModule = (await import(
  `data:text/javascript;base64,${Buffer.from(sqliteOutput[0].code).toString("base64")}`
)) as typeof import("../src/sqlite");

const sqliteBin = fs.existsSync("/usr/bin/sqlite3")
  ? "/usr/bin/sqlite3"
  : "sqlite3";

const nodeChildProcess: ChildProcessModuleLike = {
  spawn(command: string, args?: string[], options?: Record<string, unknown>) {
    const resolvedCommand = command === "sqlite3" ? sqliteBin : command;
    return cp.spawn(
      resolvedCommand,
      args ?? [],
      options
    ) as unknown as ChildProcessLike;
  },
};

function queryRealSqlite<T>(dbPath: string, query: string): Promise<T[]> {
  return sqliteModule.querySqliteDB<T>(dbPath, query, nodeChildProcess);
}

function createThingsTestDb(sqlStatements: string[]): {
  cleanup: () => void;
  dbPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "things-toolkit-db-"));
  const dbPath = path.join(dir, "main.sqlite");
  const schema = `
    CREATE TABLE TMArea (
      uuid TEXT PRIMARY KEY,
      title TEXT
    );
    CREATE TABLE TMTag (
      uuid TEXT PRIMARY KEY,
      title TEXT
    );
    CREATE TABLE TMTask (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      notes TEXT,
      startDate REAL,
      stopDate REAL,
      status INTEGER,
      area TEXT,
      project TEXT,
      heading TEXT,
      trashed INTEGER DEFAULT 0,
      type INTEGER DEFAULT 0
    );
    CREATE TABLE TMTaskTag (
      tasks TEXT,
      tags TEXT
    );
    CREATE TABLE TMChecklistItem (
      uuid TEXT PRIMARY KEY,
      task TEXT,
      title TEXT,
      stopDate REAL,
      "index" INTEGER DEFAULT 0
    );
  `;

  const script = [schema, "BEGIN TRANSACTION;", ...sqlStatements, "COMMIT;"].join("\n");
  cp.execFileSync(sqliteBin, [dbPath], {
    input: script,
    encoding: "utf8",
  });

  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("paginates >1,000 SQLite tasks with tied float timestamps and multi-tag boundary rows without loss", async () => {
  const tiedTimestamp = 1700000100.1234567;
  const midnightCutoff = 1700000000;
  const statements: string[] = [
    "INSERT INTO TMArea VALUES ('area-work', 'Work');",
    "INSERT INTO TMTag VALUES ('tag-1', 'urgent'), ('tag-2', 'deep'), ('tag-3', 'review');",
    "INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, area, trashed, type) VALUES ('proj-alpha', 'Alpha', '', NULL, NULL, 0, 'area-work', 0, 1);",
    "INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, project, trashed, type) VALUES ('heading-backend', 'Backend', '', NULL, NULL, 0, 'proj-alpha', 0, 2);",
    // Pre-cutoff task (must be excluded)
    `INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, trashed) VALUES ('task-old', 'Too Old', '', 1699900000, ${midnightCutoff - 1}, 3, 0);`,
    // Exact midnight boundary task (must be included)
    `INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, area, trashed) VALUES ('task-midnight', 'Midnight Task', '', 1699900000, ${midnightCutoff}, 3, 'area-work', 0);`,
    // Trashed task (must be excluded)
    `INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, trashed) VALUES ('task-trashed', 'Trashed', '', 1699900000, ${tiedTimestamp}, 3, 1);`,
    // Open task (stopDate IS NULL, must be excluded)
    "INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, trashed) VALUES ('task-open', 'Still Open', '', 1699900000, NULL, 0, 0);",
  ];

  // 1,250 completed/canceled tasks sharing the exact same float stopDate,
  // with multiple tags on tasks spanning the 1,000-row batch boundary.
  const totalBulkTasks = 1250;
  for (let i = 1; i <= totalBulkTasks; i++) {
    const padded = String(i).padStart(4, "0");
    const uuid = i === 1000 ? `task-${padded}'quote` : `task-${padded}`;
    const escapedUuid = uuid.replace(/'/g, "''");
    const status = i % 10 === 0 ? 2 : 3;
    const projectCol = i === 1 ? "'proj-alpha'" : "NULL";
    const headingCol = i === 2 ? "'heading-backend'" : "NULL";
    const areaCol = i > 2 ? "'area-work'" : "NULL";
    const title = i === 1000 ? "Boundary 任务 🚀" : `Task ${padded}`;
    const notes = i === 1000 ? "Line 1, with comma\nLine 2 \"quoted\"" : "";

    statements.push(
      `INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, area, project, heading, trashed) VALUES ('${escapedUuid}', '${title}', '${notes.replace(/'/g, "''")}', 1699990000, ${tiedTimestamp}, ${status}, ${areaCol}, ${projectCol}, ${headingCol}, 0);`
    );

    if (i >= 998 && i <= 1002) {
      statements.push(
        `INSERT INTO TMTaskTag VALUES ('${escapedUuid}', 'tag-1'), ('${escapedUuid}', 'tag-2'), ('${escapedUuid}', 'tag-3');`
      );
    }
  }

  const { dbPath, cleanup } = createThingsTestDb(statements);
  try {
    const records = await thingsModule.getTasksFromThingsSqlite(midnightCutoff, {
      dbPath,
      batchLimit: 1000,
      querySqlite: queryRealSqlite,
    });
    const tasks = thingsModule.buildTasksFromSQLRecords(records, []);

    assert.equal(tasks.length, totalBulkTasks + 1);

    const byId = new Map(tasks.map((task) => [task.uuid, task]));
    assert.equal(byId.has("task-old"), false);
    assert.equal(byId.has("task-trashed"), false);
    assert.equal(byId.has("task-open"), false);
    assert.equal(byId.has("task-midnight"), true);

    // Task 1: directly in project -> gets both project AND inherited project area
    assert.equal(byId.get("task-0001")?.project, "Alpha");
    assert.equal(byId.get("task-0001")?.area, "Work");

    // Task 2: under heading in project -> gets both project AND inherited project area
    assert.equal(byId.get("task-0002")?.project, "Alpha");
    assert.equal(byId.get("task-0002")?.area, "Work");

    // Boundary task 1000 (with quote in uuid, CJK+emoji, multiline notes, and 3 tags)
    const boundaryTask = byId.get("task-1000'quote");
    assert.ok(boundaryTask);
    assert.equal(boundaryTask.title, "Boundary 任务 🚀");
    assert.equal(boundaryTask.notes, 'Line 1, with comma\nLine 2 "quoted"');
    assert.deepEqual(boundaryTask.tags, ["deep", "review", "urgent"]);
    assert.equal(boundaryTask.cancelled, true);

    // Task 1001 immediately after boundary with same stopDate must NOT be dropped
    const afterBoundary = byId.get("task-1001");
    assert.ok(afterBoundary);
    assert.deepEqual(afterBoundary.tags, ["deep", "review", "urgent"]);
    assert.equal(afterBoundary.cancelled, false);
  } finally {
    cleanup();
  }
});

test("retrieves unchecked and pre-cutoff checklist items by parent task in checklist order", async () => {
  const cutoff = 1700000000;
  const statements = [
    `INSERT INTO TMTask (uuid, title, notes, startDate, stopDate, status, trashed) VALUES
      ('parent-1', 'Ship feature', '', 1600000000, ${cutoff + 500}, 3, 0),
      ('parent-2', 'Prepare notes', '', 1600000000, ${cutoff + 600}, 3, 0),
      ('parent-old', 'Excluded parent', '', 1500000000, ${cutoff - 500}, 3, 0);`,
    `INSERT INTO TMChecklistItem (uuid, task, title, stopDate, "index") VALUES
      ('cl-1', 'parent-1', 'Step 1 completed long ago', ${cutoff - 900000}, 0),
      ('cl-2', 'parent-1', 'Step 2 left unchecked', NULL, 1),
      ('cl-3', 'parent-1', 'Step 3 completed recently', ${cutoff + 400}, 2),
      ('cl-empty', 'parent-1', '   ', NULL, 3),
      ('cl-p2', 'parent-2', 'Single unchecked item', NULL, 0),
      ('cl-old', 'parent-old', 'Should not be fetched', ${cutoff + 100}, 0);`,
  ];

  const { dbPath, cleanup } = createThingsTestDb(statements);
  try {
    const taskRecords = await thingsModule.getTasksFromThingsSqlite(cutoff, {
      dbPath,
      querySqlite: queryRealSqlite,
    });
    const taskUuids = Array.from(new Set(taskRecords.map((record) => record.uuid)));
    const checklistRecords = await thingsModule.getChecklistItemsFromThingsSqlite(
      taskUuids,
      {
        dbPath,
        taskBatchSize: 1,
        querySqlite: queryRealSqlite,
      }
    );

    const tasks = thingsModule.buildTasksFromSQLRecords(
      taskRecords,
      checklistRecords
    );
    const parent1 = tasks.find((task) => task.uuid === "parent-1");
    const parent2 = tasks.find((task) => task.uuid === "parent-2");

    assert.deepEqual(parent1?.subtasks, [
      { completed: true, title: "Step 1 completed long ago" },
      { completed: false, title: "Step 2 left unchecked" },
      { completed: true, title: "Step 3 completed recently" },
    ]);
    assert.deepEqual(parent2?.subtasks, [
      { completed: false, title: "Single unchecked item" },
    ]);
    assert.equal(
      checklistRecords.some((item) => item.taskId === "parent-old"),
      false
    );
  } finally {
    cleanup();
  }
});

test("sqlite query waits for close after exit and preserves split UTF-8 byte chunks", async () => {
  const csvBytes = Buffer.from("uuid,title\r\nt1,完成任务 🎉\r\n", "utf8");
  // Split right inside a 3-byte CJK character
  const splitPoint = csvBytes.indexOf(Buffer.from("任", "utf8")) + 1;
  const firstHalf = csvBytes.subarray(0, splitPoint);
  const secondHalf = csvBytes.subarray(splitPoint);

  const mockChildProcess: ChildProcessModuleLike = {
    spawn: () => {
      const proc = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      queueMicrotask(() => {
        stdout.emit("data", firstHalf);
        // Simulate 'exit' firing BEFORE final stdout chunk and 'close'
        proc.emit("exit", 0);
        queueMicrotask(() => {
          stdout.emit("data", secondHalf);
          proc.emit("close", 0);
        });
      });

      return {
        on: proc.on.bind(proc),
        stdout: { on: stdout.on.bind(stdout) },
        stderr: { on: stderr.on.bind(stderr) },
      } as ChildProcessLike;
    },
  };

  const rows = await sqliteModule.querySqliteDB<{ uuid: string; title: string }>(
    "/fake/main.sqlite",
    "SELECT 1",
    mockChildProcess
  );
  assert.deepEqual(rows, [{ uuid: "t1", title: "完成任务 🎉" }]);
});

test("sqlite query settles on spawn error instead of hanging", async () => {
  const mockChildProcess: ChildProcessModuleLike = {
    spawn: () => {
      const proc = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      queueMicrotask(() => {
        proc.emit("error", new Error("spawn sqlite3 ENOENT"));
      });

      return {
        on: proc.on.bind(proc),
        stdout: { on: stdout.on.bind(stdout) },
        stderr: { on: stderr.on.bind(stderr) },
      } as ChildProcessLike;
    },
  };

  await assert.rejects(
    sqliteModule.querySqliteDB("/fake/main.sqlite", "SELECT 1", mockChildProcess),
    /spawn sqlite3 ENOENT/
  );
});

test("AppleScript sets day to 1 before year/month to prevent end-of-month rollover", () => {
  const fakeCutoff = {
    year: () => 2025,
    month: () => 1, // February (0-indexed)
    date: () => 15,
    clone: () => ({ startOf: () => fakeCutoff }),
    diff: () => 0,
  } as unknown as MomentLike;

  const script = thingsModule.buildThingsToolkitAppleScript(fakeCutoff);
  const dayResetIndex = script.indexOf("set day of cutoff to 1");
  const yearIndex = script.indexOf("set year of cutoff to 2025");
  const monthIndex = script.indexOf("set month of cutoff to 2");
  const daySetIndex = script.indexOf("set day of cutoff to 15");

  assert.ok(dayResetIndex > -1 && dayResetIndex < yearIndex);
  assert.ok(yearIndex < monthIndex && monthIndex < daySetIndex);
  assert.match(script, /completion date >= cutoff/);
  assert.match(script, /cancellation date >= cutoff/);
});

test("AppleScript JSON record builder handles invalid dates and skips missing ids", () => {
  const records = thingsModule.buildTaskRecordsFromAppleScriptJson([
    {
      id: "task-1",
      name: "Valid task",
      status: "completed",
      completionDate: "not-a-valid-date",
      tagNames: "Work, Urgent",
    },
    {
      id: "",
      name: "Missing id",
      status: "completed",
    },
  ]);

  assert.equal(records.length, 2);
  assert.equal(records[0].stopDate, 0);
  assert.equal(Number.isNaN(records[0].stopDate), false);
  assert.deepEqual(
    records.map((r) => r.tag),
    ["Work", "Urgent"]
  );
});

test("findThingsSqlitePath skips empty ThingsData folders and picks the newest database", () => {
  const existing = new Map<string, number>([
    [
      "/home/test/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-OLD/Things Database.thingsdatabase/main.sqlite",
      1000,
    ],
    [
      "/home/test/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-NEW/Things Database.thingsdatabase/main.sqlite",
      2000,
    ],
  ]);

  const found = thingsModule.findThingsSqlitePath({
    os: { homedir: () => "/home/test" },
    path: { join: (...parts: string[]) => path.posix.join(...parts) },
    fs: {
      readdirSync: () => ["ThingsData-EMPTY", "ThingsData-OLD", "ThingsData-NEW"],
      existsSync: (filePath: string) => existing.has(filePath),
      statSync: (filePath: string) => ({ mtimeMs: existing.get(filePath) ?? 0 }),
    },
  });

  assert.match(found, /ThingsData-NEW/);
  assert.equal(
    thingsModule.isFileAccessDeniedError(new Error("Operation not permitted")),
    true
  );
});

test("buildTasksFromSQLRecords safely handles prototype-key UUIDs and deduplicates checklists", () => {
  const tasks = thingsModule.buildTasksFromSQLRecords(
    [
      {
        uuid: "constructor",
        title: "Proto-safe task",
        notes: "",
        startDate: 0,
        stopDate: "1700000000" as unknown as number,
        status: "3",
        tag: "alpha",
      },
    ],
    [
      {
        uuid: "cl-1",
        taskId: "constructor",
        title: "Unchecked with string zero",
        startDate: 0,
        stopDate: "0" as unknown as number,
      },
      {
        uuid: "cl-1",
        taskId: "constructor",
        title: "Unchecked with string zero",
        startDate: 0,
        stopDate: "0" as unknown as number,
      },
    ]
  );

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].uuid, "constructor");
  assert.equal(tasks[0].stopDate, 1700000000);
  assert.deepEqual(tasks[0].subtasks, [
    { completed: false, title: "Unchecked with string zero" },
  ]);
});
