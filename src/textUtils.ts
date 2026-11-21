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
  const clampedLevel = Math.min(6, Math.max(1, Math.floor(level)));
  const hash = "".padStart(clampedLevel, "#");
  return `${emptyLine}${hash} ${title}`;
}

export function getTab(useTab?: boolean, tabSize?: number): string {
  if (useTab ?? true) {
    return "\t";
  }
  const normalizedSize =
    typeof tabSize === "number" && Number.isFinite(tabSize) && tabSize > 0
      ? Math.floor(tabSize)
      : 4;
  return "".padStart(normalizedSize, " ");
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
  }, Object.create(null) as Record<string | number, T[]>);
}

export async function updateSection(
  app: App,
  file: TFile,
  heading: string,
  sectionContents: string
): Promise<boolean> {
  const { vault } = app;
  const editor = getEditorForFile(app, file);
  if (!editor) {
    let didChange = false;
    await vault.process(file, (fileContents) => {
      const update = buildLogbookSectionUpdate(fileContents, heading, sectionContents);
      didChange = update.didChange;
      return update.contents;
    });
    return didChange;
  }

  const fileContents = editor.getValue();
  const update = buildLogbookSectionUpdate(
    fileContents,
    heading,
    sectionContents
  );

  if (!update.didChange) {
    return false;
  }

  const currentLines = fileContents.split("\n");
  if (update.rangesToUpdate.length === 0) {
    const to = getEditorEndPosition(currentLines);
    editor.replaceRange(
      getAppendText(fileContents, update.managedSection),
      to,
      to
    );
    return true;
  }

  const managedLines = update.managedSection.split("\n");
  [...update.rangesToUpdate]
    .sort((left, right) => right.startLine - left.startLine)
    .forEach((range) => {
      const isReplacement = Boolean(
        update.replacementRange && isSameRange(range, update.replacementRange)
      );

      if (isReplacement) {
        const hasTrailingLines = range.endLine < currentLines.length;
        const replacementText = hasTrailingLines
          ? `${update.managedSection}\n`
          : update.managedSection;
        editor.replaceRange(
          replacementText,
          { line: range.startLine, ch: 0 },
          getEditorRangeEndPosition(currentLines, range)
        );
        currentLines.splice(
          range.startLine,
          range.endLine - range.startLine,
          ...managedLines
        );
        return;
      }

      const from =
        range.endLine < currentLines.length || range.startLine === 0
          ? { line: range.startLine, ch: 0 }
          : {
              line: range.startLine - 1,
              ch: currentLines[range.startLine - 1].length,
            };
      const to = getEditorRangeEndPosition(currentLines, range);
      editor.replaceRange("", from, to);
      currentLines.splice(range.startLine, range.endLine - range.startLine);
    });
  return true;
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
