import type { App, TFile } from "obsidian";
import { getEditorForFile } from "./fileUtils";

export function getHeadingLevel(line = ""): number | null {
  const heading = line.match(/^(#{1,6})\s+\S/);
  return heading ? heading[1].length : null;
}

export function toHeading(title: string, level: number, addEmptyLine: boolean): string {
  const emptyLine = addEmptyLine ? "\n" : "";
  const hash = "".padStart(level, "#");
  return `${emptyLine}${hash} ${title}`;
}

export function getTab(useTab: boolean, tabSize: number): string {
  if (useTab) {
    return "\t";
  }
  return "".padStart(tabSize, " ");
}

export function groupBy<T>(
  arr: T[],
  predicate: (item: T) => string | number
): Record<string | number, T[]> {
  return arr.reduce((acc, elem) => {
    const val = predicate(elem);
    acc[val] = acc[val] || [];
    acc[val].push(elem);
    return acc;
  }, {} as Record<string | number, T[]>);
}

export function isMacOS(): boolean {
  return navigator.userAgent.includes("Mac");
}

export async function updateSection(
  app: App,
  file: TFile,
  heading: string,
  sectionContents: string
): Promise<boolean> {
  const headingLevel = getHeadingLevel(heading);
  if (!headingLevel) {
    throw new Error(`Invalid logbook section heading: ${heading}`);
  }

  const { vault } = app;
  const fileContents = await vault.read(file);
  const fileLines = fileContents.split("\n");

  let logbookSectionLineNum = -1;
  let nextSectionLineNum = -1;

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() === heading) {
      logbookSectionLineNum = i;
    } else if (logbookSectionLineNum !== -1) {
      const currLevel = getHeadingLevel(fileLines[i]);
      if (currLevel && currLevel <= headingLevel) {
        nextSectionLineNum = i;
        break;
      }
    }
  }

  const editor = getEditorForFile(app, file);
  if (editor) {
    if (logbookSectionLineNum !== -1) {
      const currentSection = fileLines
        .slice(
          logbookSectionLineNum,
          nextSectionLineNum !== -1 ? nextSectionLineNum : fileLines.length
        )
        .join("\n")
        .trimEnd();
      if (currentSection === sectionContents.trimEnd()) {
        return false;
      }

      const from = { line: logbookSectionLineNum, ch: 0 };
      const to =
        nextSectionLineNum !== -1
          ? { line: nextSectionLineNum, ch: 0 }
          : { line: fileLines.length, ch: 0 };
      editor.replaceRange(`${sectionContents}\n`, from, to);
      return true;
    }

    const pos = { line: fileLines.length, ch: 0 };
    editor.replaceRange(`\n\n${sectionContents}`, pos, pos);
    return true;
  }

  if (logbookSectionLineNum !== -1) {
    const prefix = fileLines.slice(0, logbookSectionLineNum);
    const suffix =
      nextSectionLineNum !== -1 ? fileLines.slice(nextSectionLineNum) : [];
    const currentSection = fileLines
      .slice(
        logbookSectionLineNum,
        nextSectionLineNum !== -1 ? nextSectionLineNum : fileLines.length
      )
      .join("\n")
      .trimEnd();

    if (currentSection === sectionContents.trimEnd()) {
      return false;
    }

    await vault.process(file, () => [...prefix, sectionContents, ...suffix].join("\n"));
    return true;
  }

  await vault.process(file, () => [...fileLines, "", sectionContents].join("\n"));
  return true;
}

export function getSectionContents(
  fileContents: string,
  heading: string
): string {
  const headingLevel = getHeadingLevel(heading);
  if (!headingLevel) {
    return "";
  }

  const fileLines = fileContents.split("\n");
  let sectionLineNum = -1;
  let nextSectionLineNum = fileLines.length;

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() === heading) {
      sectionLineNum = i;
    } else if (sectionLineNum !== -1) {
      const currLevel = getHeadingLevel(fileLines[i]);
      if (currLevel && currLevel <= headingLevel) {
        nextSectionLineNum = i;
        break;
      }
    }
  }

  if (sectionLineNum === -1) {
    return "";
  }

  return fileLines.slice(sectionLineNum, nextSectionLineNum).join("\n");
}

export function countThingsTasksInSection(
  fileContents: string,
  heading: string
): number {
  const sectionContents = getSectionContents(fileContents, heading);
  if (!sectionContents) {
    return 0;
  }

  return sectionContents
    .split("\n")
    .filter((line) => /^- \[[ xXcC]\] .*things:\/\/\/show\?id=/.test(line))
    .length;
}
