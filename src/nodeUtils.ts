interface DesktopWindow extends Window {
  require?: (moduleName: string) => unknown;
}

type ModuleRequire = (moduleName: string) => unknown;

declare const require: ModuleRequire | undefined;

export interface ChildProcessLike {
  on(event: "close" | "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  stderr: StreamLike;
  stdout: StreamLike;
}

export interface ChildProcessModuleLike {
  spawn(
    command: string,
    args?: string[],
    options?: Record<string, unknown>
  ): ChildProcessLike;
}

export interface FsModuleLike {
  existsSync(filePath: string): boolean;
  readdirSync(dirPath: string): string[];
}

export interface OsModuleLike {
  homedir(): string;
}

export interface PathModuleLike {
  join(...parts: string[]): string;
}

interface StreamLike {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

function requireDesktopModule<T>(moduleName: string): T {
  const requireFns: ModuleRequire[] = [];

  if (typeof require === "function") {
    requireFns.push(require);
  }

  const windowRequire = (window as DesktopWindow).require;
  if (typeof windowRequire === "function") {
    requireFns.push(windowRequire.bind(window));
  }

  if (requireFns.length === 0) {
    throw new Error(`${moduleName} is only available in Obsidian desktop`);
  }

  let lastError: unknown;
  for (const requireFn of requireFns) {
    try {
      return requireFn(moduleName) as T;
    } catch (err) {
      lastError = err;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Unable to load ${moduleName}: ${message}`);
}

export function getChildProcessModule(): ChildProcessModuleLike {
  return requireDesktopModule<ChildProcessModuleLike>("child_process");
}

export function getFsModule(): FsModuleLike {
  return requireDesktopModule<FsModuleLike>("fs");
}

export function getOsModule(): OsModuleLike {
  return requireDesktopModule<OsModuleLike>("os");
}

export function getPathModule(): PathModuleLike {
  return requireDesktopModule<PathModuleLike>("path");
}