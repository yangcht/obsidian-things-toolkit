import type { App, TFile } from "obsidian";

import { getEditorForFile } from "./fileUtils";
import {
  buildLogbookSectionUpdate,
  getAppendText,
  isSameRange,
  type SectionRange,
} from "./logbookSection";

export {
  countThingsTasksInSection,
  getHeadingLevel,
  updateSectionContents,
} from "./logbookSection";

export function toHeading(
  title: string,
  level: number,
  addEmptyLine: boolean
): string {
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

export async function updateSection(
  app: App,
  file: TFile,
  heading: string,
  sectionContents: string
): Promise<boolean> {
  const { vault } = app;
  const fileContents = await vault.read(file);
  const update = buildLogbookSectionUpdate(
    fileContents,
    heading,
    sectionContents
  );

  if (!update.didChange) {
    return false;
  }

  const editor = getEditorForFile(app, file);
  if (editor) {
    const fileLines = fileContents.split("\n");
    if (update.rangesToUpdate.length === 0) {
      const to = getEditorEndPosition(fileLines);
      editor.replaceRange(
        getAppendText(fileContents, update.managedSection),
        to,
        to
      );
      return true;
    }

    [...update.rangesToUpdate]
      .sort((left, right) => right.startLine - left.startLine)
      .forEach((range) => {
        const replacementText =
          update.replacementRange && isSameRange(range, update.replacementRange)
            ? getReplacementText(fileLines, range, update.managedSection)
            : "";
        editor.replaceRange(
          replacementText,
          { line: range.startLine, ch: 0 },
          getEditorRangeEndPosition(fileLines, range)
        );
      });
    return true;
  }

  await vault.process(file, () => update.contents);
  return true;
}

function getReplacementText(
  fileLines: string[],
  range: SectionRange,
  managedSection: string
): string {
  const suffix = range.endLine < fileLines.length ? "\n" : "";
  return `${managedSection}${suffix}`;
}

function getEditorEndPosition(fileLines: string[]): { line: number; ch: number } {
  const lastLine = Math.max(0, fileLines.length - 1);
  return { line: lastLine, ch: fileLines[lastLine].length };
}

function getEditorRangeEndPosition(
  fileLines: string[],
  range: SectionRange
): { line: number; ch: number } {
  if (range.endLine < fileLines.length) {
    return { line: range.endLine, ch: 0 };
  }

  return getEditorEndPosition(fileLines);
}
