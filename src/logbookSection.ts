export function getHeadingLevel(line = ""): number | null {
  const heading = line.match(/^(#{1,6})\s+\S/);
  return heading ? heading[1].length : null;
}

export const LOGBOOK_SECTION_START_MARKER =
  "<!-- things-toolkit-logbook:start -->";
export const LOGBOOK_SECTION_END_MARKER =
  "<!-- things-toolkit-logbook:end -->";

const THINGS_TASK_LINE_REGEX =
  /^- \[[^\]]+\] .*things:\/\/\/show\?id=([^\s)]+)/;

export interface SectionRange {
  startLine: number;
  endLine: number;
  taskIds: Set<string>;
}

export interface SectionContentUpdate {
  contents: string;
  didChange: boolean;
}

export interface LogbookSectionUpdate extends SectionContentUpdate {
  managedSection: string;
  rangesToUpdate: SectionRange[];
  replacementRange: SectionRange | null;
}

function detectLineEnding(contents: string): "\r\n" | "\n" {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(contents: string): string {
  return contents.replace(/\r\n?/g, "\n");
}

function applyLineEnding(contents: string, lineEnding: "\r\n" | "\n"): string {
  return lineEnding === "\r\n" ? contents.replace(/\n/g, "\r\n") : contents;
}

export function updateSectionContents(
  fileContents: string,
  heading: string,
  sectionContents: string
): SectionContentUpdate {
  const update = buildLogbookSectionUpdate(
    fileContents,
    heading,
    sectionContents
  );

  return {
    contents: update.contents,
    didChange: update.didChange,
  };
}

export function buildLogbookSectionUpdate(
  fileContents: string,
  heading: string,
  sectionContents: string
): LogbookSectionUpdate {
  const headingLine = getLogbookHeadingLine(heading);
  if (!getHeadingLevel(headingLine)) {
    throw new Error(`Invalid logbook section heading: ${heading}`);
  }

  const lineEnding = detectLineEnding(fileContents);
  const normalizedFileContents = normalizeLineEndings(fileContents);
  const managedSection = toManagedLogbookSection(sectionContents);
  const fileLines = normalizedFileContents.split("\n");
  const fencedLines = getFencedCodeLineFlags(fileLines);
  const renderedTaskIds = extractThingsTaskIds(
    normalizeLineEndings(sectionContents).split("\n")
  );
  const markedRanges = findMarkedLogbookSectionRanges(fileLines, fencedLines);
  // A heading inside a marked block must not extend past its closing marker.
  const isOutsideMarkedSections = (range: SectionRange): boolean =>
    !markedRanges.some(
      (marked) => range.startLine >= marked.startLine && range.startLine < marked.endLine
    );
  const exactHeadingRanges = findHeadingSectionRanges(
    fileLines,
    headingLine,
    fencedLines
  ).filter(isOutsideMarkedSections);
  const legacyRanges = findGeneratedLogbookSectionRanges(
    fileLines,
    fencedLines
  ).filter(
    (range) => isOutsideMarkedSections(range) && hasSharedTaskId(range.taskIds, renderedTaskIds)
  );
  const targetRange =
    markedRanges[0] || exactHeadingRanges[0] || legacyRanges[0];

  if (!targetRange) {
    const nextNormalizedContents = appendLogbookSection(
      normalizedFileContents,
      managedSection
    );
    const nextContents = applyLineEnding(nextNormalizedContents, lineEnding);
    return {
      contents: nextContents,
      didChange: nextContents !== fileContents,
      managedSection,
      rangesToUpdate: [],
      replacementRange: null,
    };
  }

  const rangesToUpdate = normalizeSectionRanges([
    ...markedRanges,
    ...exactHeadingRanges,
    ...legacyRanges,
  ]);
  const replacementRange =
    rangesToUpdate.find((range) => isSameRange(range, targetRange)) ||
    rangesToUpdate[0];
  const nextNormalizedContents = replaceSectionRanges(
    fileLines,
    rangesToUpdate,
    replacementRange,
    managedSection
  );
  const nextContents = applyLineEnding(nextNormalizedContents, lineEnding);

  return {
    contents: nextContents,
    didChange: nextContents !== fileContents,
    managedSection,
    rangesToUpdate,
    replacementRange,
  };
}

export function getSectionContents(
  fileContents: string,
  heading: string
): string {
  const headingLine = getLogbookHeadingLine(heading);
  if (!getHeadingLevel(headingLine)) {
    return "";
  }

  const fileLines = normalizeLineEndings(fileContents).split("\n");
  const fencedLines = getFencedCodeLineFlags(fileLines);
  const markedRange = findMarkedLogbookSectionRanges(fileLines, fencedLines)[0];
  const exactRange = findHeadingSectionRanges(fileLines, headingLine, fencedLines)[0];
  const legacyRange = findGeneratedLogbookSectionRanges(fileLines, fencedLines)[0];
  const sectionRange = markedRange || exactRange || legacyRange;

  return sectionRange ? getSectionRangeContents(fileLines, sectionRange) : "";
}

export function countThingsTasksInSection(
  fileContents: string,
  heading: string
): number {
  const sectionContents = getSectionContents(fileContents, heading);
  if (!sectionContents) {
    return 0;
  }

  return extractThingsTaskIds(sectionContents.split("\n")).size;
}

export function getAppendText(
  fileContents: string,
  managedSection: string
): string {
  if (!fileContents) {
    return managedSection;
  }

  const normalized = normalizeLineEndings(fileContents);
  const separator = normalized.endsWith("\n\n")
    ? ""
    : normalized.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${separator}${managedSection}`;
}

export function isSameRange(left: SectionRange, right: SectionRange): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

function getFencedCodeLineFlags(fileLines: string[]): boolean[] {
  const flags = new Array<boolean>(fileLines.length).fill(false);
  let activeFenceChar: "`" | "~" | null = null;
  let activeFenceLength = 0;

  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    if (activeFenceChar === null) {
      const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const fence = openMatch[1];
        const info = openMatch[2];
        const fenceChar = fence[0] as "`" | "~";
        if (fenceChar === "~" || !info.includes("`")) {
          activeFenceChar = fenceChar;
          activeFenceLength = fence.length;
          flags[i] = true;
        }
      }
      continue;
    }

    flags[i] = true;
    const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (
      closeMatch &&
      closeMatch[1][0] === activeFenceChar &&
      closeMatch[1].length >= activeFenceLength
    ) {
      activeFenceChar = null;
      activeFenceLength = 0;
    }
  }

  return flags;
}

function getLogbookHeadingLine(heading: string): string {
  return (
    normalizeLineEndings(heading)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => getHeadingLevel(line) !== null) || heading.trim()
  );
}

function toManagedLogbookSection(sectionContents: string): string {
  const trimmedSectionContents = normalizeLineEndings(sectionContents).trimEnd();
  if (
    trimmedSectionContents.startsWith(LOGBOOK_SECTION_START_MARKER) &&
    trimmedSectionContents.endsWith(LOGBOOK_SECTION_END_MARKER)
  ) {
    return trimmedSectionContents;
  }

  return [
    LOGBOOK_SECTION_START_MARKER,
    trimmedSectionContents,
    LOGBOOK_SECTION_END_MARKER,
  ].join("\n");
}

function appendLogbookSection(
  fileContents: string,
  managedSection: string
): string {
  return `${fileContents}${getAppendText(fileContents, managedSection)}`;
}

function findMarkedLogbookSectionRanges(
  fileLines: string[],
  fencedLines: boolean[]
): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    if (fencedLines[i] || fileLines[i].trim() !== LOGBOOK_SECTION_START_MARKER) {
      continue;
    }

    let endMarkerLine = -1;
    for (let j = i + 1; j < fileLines.length; j++) {
      if (fencedLines[j]) {
        continue;
      }

      const trimmed = fileLines[j].trim();
      if (trimmed === LOGBOOK_SECTION_START_MARKER) {
        // Ignore an unclosed start marker so user notes before the next block are preserved.
        i = j - 1;
        endMarkerLine = -2;
        break;
      }

      if (trimmed === LOGBOOK_SECTION_END_MARKER) {
        endMarkerLine = j;
        break;
      }
    }

    if (endMarkerLine >= 0) {
      ranges.push(createSectionRange(fileLines, i, endMarkerLine + 1));
      i = endMarkerLine;
    }
  }

  return ranges;
}

function findHeadingSectionRanges(
  fileLines: string[],
  headingLine: string,
  fencedLines: boolean[]
): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    if (fencedLines[i] || fileLines[i].trim() !== headingLine) {
      continue;
    }

    const headingLevel = getHeadingLevel(fileLines[i]);
    if (!headingLevel) {
      continue;
    }

    ranges.push(
      createSectionRange(
        fileLines,
        i,
        findSectionEndLine(fileLines, i, headingLevel, fencedLines)
      )
    );
  }

  return ranges;
}

function findGeneratedLogbookSectionRanges(
  fileLines: string[],
  fencedLines: boolean[]
): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    if (fencedLines[i]) {
      continue;
    }

    const headingLevel = getHeadingLevel(fileLines[i]);
    if (!headingLevel) {
      continue;
    }

    const endLine = findSectionEndLine(fileLines, i, headingLevel, fencedLines);
    const sectionLines = fileLines.slice(i, endLine);
    if (isGeneratedLogbookSection(sectionLines, headingLevel)) {
      ranges.push(createSectionRange(fileLines, i, endLine));
    }
  }

  return removeContainedRanges(ranges);
}

function findSectionEndLine(
  fileLines: string[],
  startLine: number,
  headingLevel: number,
  fencedLines: boolean[]
): number {
  for (let i = startLine + 1; i < fileLines.length; i++) {
    if (fencedLines[i]) {
      continue;
    }

    const currentHeadingLevel = getHeadingLevel(fileLines[i]);
    if (currentHeadingLevel && currentHeadingLevel <= headingLevel) {
      return i;
    }
  }

  return fileLines.length;
}

function createSectionRange(
  fileLines: string[],
  startLine: number,
  endLine: number
): SectionRange {
  return {
    startLine,
    endLine,
    taskIds: extractThingsTaskIds(fileLines.slice(startLine, endLine)),
  };
}

function isGeneratedLogbookSection(
  sectionLines: string[],
  headingLevel: number
): boolean {
  const taskIds = extractThingsTaskIds(sectionLines);
  if (taskIds.size === 0) {
    return false;
  }

  return sectionLines.slice(1).every((line) => {
    if (!line.trim()) {
      return true;
    }

    const currentHeadingLevel = getHeadingLevel(line);
    if (currentHeadingLevel) {
      return currentHeadingLevel > headingLevel;
    }

    return THINGS_TASK_LINE_REGEX.test(line) || isIndentedLine(line);
  });
}

function isIndentedLine(line: string): boolean {
  return line.startsWith("\t") || line.startsWith(" ");
}

function extractThingsTaskIds(lines: string[]): Set<string> {
  const taskIds = new Set<string>();

  lines.forEach((line) => {
    const taskMatch = line.match(THINGS_TASK_LINE_REGEX);
    if (taskMatch?.[1]) {
      taskIds.add(taskMatch[1]);
    }
  });

  return taskIds;
}

function hasSharedTaskId(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) {
    return false;
  }

  for (const taskId of left) {
    if (right.has(taskId)) {
      return true;
    }
  }

  return false;
}

function normalizeSectionRanges(ranges: SectionRange[]): SectionRange[] {
  return [...ranges]
    .sort(
      (left, right) =>
        left.startLine - right.startLine || right.endLine - left.endLine
    )
    .reduce<SectionRange[]>((acc, range) => {
      const previousRange = acc[acc.length - 1];
      if (!previousRange || range.startLine >= previousRange.endLine) {
        acc.push(range);
        return acc;
      }

      if (range.endLine > previousRange.endLine) {
        previousRange.endLine = range.endLine;
      }

      return acc;
    }, []);
}

function removeContainedRanges(ranges: SectionRange[]): SectionRange[] {
  return ranges.filter(
    (range) =>
      !ranges.some(
        (otherRange) =>
          otherRange.startLine < range.startLine &&
          range.endLine <= otherRange.endLine
      )
  );
}

function replaceSectionRanges(
  fileLines: string[],
  ranges: SectionRange[],
  replacementRange: SectionRange,
  managedSection: string
): string {
  const nextLines: string[] = [];
  let cursor = 0;

  ranges.forEach((range) => {
    nextLines.push(...fileLines.slice(cursor, range.startLine));

    if (isSameRange(range, replacementRange)) {
      nextLines.push(...managedSection.split("\n"));
    }

    cursor = range.endLine;
  });

  nextLines.push(...fileLines.slice(cursor));
  return nextLines.join("\n");
}

function getSectionRangeContents(
  fileLines: string[],
  range: SectionRange
): string {
  const isMarkedRange =
    fileLines[range.startLine]?.trim() === LOGBOOK_SECTION_START_MARKER &&
    fileLines[range.endLine - 1]?.trim() === LOGBOOK_SECTION_END_MARKER;
  const startLine = isMarkedRange ? range.startLine + 1 : range.startLine;
  const endLine = isMarkedRange ? range.endLine - 1 : range.endLine;

  return fileLines.slice(startLine, endLine).join("\n");
}
