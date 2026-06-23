import Papa from "papaparse";

import { getChildProcessModule } from "./nodeUtils";

export const TASK_FETCH_LIMIT = 1000;

interface ISpawnResults {
  stdOut: string[];
  stdErr: string[];
  code: number | null;
}

function chunkToString(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

function parseCSV<T>(csv: string[]): T[] {
  const lines = csv.join("");
  return Papa.parse<T>(lines, {
    dynamicTyping: false,
    header: true,
    skipEmptyLines: true,
  }).data;
}

async function handleSqliteQuery(
  dbPath: string,
  query: string
): Promise<ISpawnResults> {
  return new Promise((done) => {
    const stdOut: string[] = [];
    const stdErr: string[] = [];
    let settled = false;
    const finish = (result: ISpawnResults) => {
      if (!settled) {
        settled = true;
        done(result);
      }
    };

    const childProcess = getChildProcessModule();
    const spawned = childProcess.spawn(
      "sqlite3",
      ["-csv", "-header", "-readonly", dbPath, query],
      { detached: true }
    );

    spawned.stdout.on("data", (chunk: unknown) => {
      stdOut.push(chunkToString(chunk));
    });
    spawned.stderr.on("data", (chunk: unknown) => {
      stdErr.push(chunkToString(chunk));
    });

    spawned.on("error", (err: Error) => {
      stdErr.push(err.stack ?? err.message);
    });
    spawned.on("close", (code: number | null) => finish({ stdErr, stdOut, code }));
    spawned.on("exit", (code: number | null) => finish({ stdErr, stdOut, code }));
  });
}

export async function querySqliteDB<T>(
  dbPath: string,
  query: string
): Promise<T[]> {
  const { stdOut, stdErr, code } = await handleSqliteQuery(dbPath, query);
  if (stdErr.length || code !== 0) {
    const error = stdErr.join("") || `sqlite3 exited with code ${String(code)}`;
    throw new Error(error);
  }
  return parseCSV<T>(stdOut);
}
