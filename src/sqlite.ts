import { parse } from "papaparse";

import {
  getChildProcessModule,
  type ChildProcessModuleLike,
} from "./nodeUtils";

const SQLITE_BUSY_TIMEOUT_MS = 5000;

interface ISpawnResults {
  stdOut: string[];
  stdErr: string[];
  code: number | null;
}

export function decodeStreamChunk(decoder: TextDecoder, chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return decoder.decode(chunk, { stream: true });
  }
  return String(chunk);
}

function parseCSV<T>(csv: string[]): T[] {
  const lines = csv.join("");
  if (!lines.trim()) {
    return [];
  }

  const result = parse<T>(lines, {
    dynamicTyping: false,
    header: true,
    skipEmptyLines: true,
  });

  return result.data;
}

async function handleSqliteQuery(
  dbPath: string,
  query: string,
  childProcess: ChildProcessModuleLike = getChildProcessModule()
): Promise<ISpawnResults> {
  return new Promise((done) => {
    const stdOut: string[] = [];
    const stdErr: string[] = [];
    const stdOutDecoder = new TextDecoder("utf-8");
    const stdErrDecoder = new TextDecoder("utf-8");
    let settled = false;

    const finish = (code: number | null) => {
      if (!settled) {
        settled = true;
        const trailingOut = stdOutDecoder.decode();
        if (trailingOut) {
          stdOut.push(trailingOut);
        }
        const trailingErr = stdErrDecoder.decode();
        if (trailingErr) {
          stdErr.push(trailingErr);
        }
        done({ stdErr, stdOut, code });
      }
    };

    const spawned = childProcess.spawn("sqlite3", [
      "-csv",
      "-header",
      "-readonly",
      "-cmd",
      `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`,
      dbPath,
      query,
    ]);

    spawned.stdout.on("data", (chunk: unknown) => {
      stdOut.push(decodeStreamChunk(stdOutDecoder, chunk));
    });

    spawned.stderr.on("data", (chunk: unknown) => {
      stdErr.push(decodeStreamChunk(stdErrDecoder, chunk));
    });

    spawned.on("error", (err: Error) => {
      stdErr.push(err.stack ?? err.message);
      finish(null);
    });

    spawned.on("close", (code: number | null) => {
      finish(code);
    });
  });
}

export async function querySqliteDB<T>(
  dbPath: string,
  query: string,
  childProcess?: ChildProcessModuleLike
): Promise<T[]> {
  const { stdOut, stdErr, code } = await handleSqliteQuery(
    dbPath,
    query,
    childProcess
  );

  if (stdErr.length || code !== 0) {
    const error = stdErr.join("") || `sqlite3 exited with code ${String(code)}`;
    throw new Error(error);
  }

  return parseCSV<T>(stdOut);
}