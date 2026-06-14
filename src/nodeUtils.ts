import { Platform } from "obsidian";

interface DesktopWindow extends Window {
  require?: (moduleName: string) => unknown;
}

declare const require:
  | ((moduleName: string) => unknown)
  | undefined;

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
  if (!Platform.isDesktopApp) {
    throw new Error(`${moduleName} is only available in Obsidian desktop`);
  }

  const requireFn =
    (window as DesktopWindow).require ||
    (typeof require === "function" ? require : undefined);
  if (!requireFn) {
    throw new Error("Obsidian desktop require API is unavailable");
  }

  return requireFn(moduleName) as T;
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
