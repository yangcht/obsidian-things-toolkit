import { spawn } from "child_process";
import Papa from "papaparse";

export const TASK_FETCH_LIMIT = 1000;

interface ISpawnResults {
  stdOut: Buffer[];
  stdErr: Buffer[];
  code: number;
}

function parseCSV<T>(csv: Buffer[]): T[] {
  const lines = Buffer.concat(csv).toString("utf-8");
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
    const stdOut: Buffer[] = [];
    const stdErr: Buffer[] = [];
    let settled = false;
    const finish = (result: ISpawnResults) => {
      if (!settled) {
        settled = true;
        done(result);
      }
    };

    const spawned = spawn(
      "sqlite3",
      ["-csv", "-header", "-readonly", dbPath, query],
      { detached: true }
    );

    spawned.stdout.on("data", (buffer: Buffer) => {
      stdOut.push(buffer);
    });
    spawned.stderr.on("data", (buffer: Buffer) => {
      stdErr.push(buffer);
    });

    spawned.on("error", (err: Error) => {
      stdErr.push(Buffer.from(String(err.stack), "ascii"));
    });
    spawned.on("close", (code: number) => finish({ stdErr, stdOut, code }));
    spawned.on("exit", (code: number) => finish({ stdErr, stdOut, code }));
  });
}

export async function querySqliteDB<T>(
  dbPath: string,
  query: string
): Promise<T[]> {
  const { stdOut, stdErr } = await handleSqliteQuery(dbPath, query);
  if (stdErr.length) {
    const error = Buffer.concat(stdErr).toString("utf-8");
    return Promise.reject(error);
  }
  return parseCSV<T>(stdOut);
}
