export function getHeadingLevel(line = ""): number | null {
  const heading = line.match(/^(#{1,6})\s+\S/);
  return heading ? heading[1].length : null;
}

export const LOGBOOK_SECTION_START_MARKER =
  "<!-- things-toolkit-logbook:start -->";
export const LOGBOOK_SECTION_END_MARKER =
  "<!-- things-toolkit-logbook:end -->";

const THINGS_TASK_LINE_REGEX =
  /^- \[[ xXcC]\] .*things:\/\/\/show\?id=([^\s)]+)/;

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

  const managedSection = toManagedLogbookSection(sectionContents);
  const fileLines = fileContents.split("\n");
  const renderedTaskIds = extractThingsTaskIds(sectionContents.split("\n"));
  const markedRanges = findMarkedLogbookSectionRanges(fileLines);
  const exactHeadingRanges = findHeadingSectionRanges(fileLines, headingLine);
  const legacyRanges = findGeneratedLogbookSectionRanges(fileLines).filter(
    (range) => hasSharedTaskId(range.taskIds, renderedTaskIds)
  );
  const targetRange =
    markedRanges[0] || exactHeadingRanges[0] || legacyRanges[0];

  if (!targetRange) {
    const nextContents = appendLogbookSection(fileContents, managedSection);
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
  const nextContents = replaceSectionRanges(
    fileLines,
    rangesToUpdate,
    replacementRange,
    managedSection
  );

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

  const fileLines = fileContents.split("\n");
  const markedRange = findMarkedLogbookSectionRanges(fileLines)[0];
  const exactRange = findHeadingSectionRanges(fileLines, headingLine)[0];
  const legacyRange = findGeneratedLogbookSectionRanges(fileLines)[0];
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

  const separator = fileContents.endsWith("\n\n")
    ? ""
    : fileContents.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${separator}${managedSection}`;
}

export function isSameRange(left: SectionRange, right: SectionRange): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine;
}

function getLogbookHeadingLine(heading: string): string {
  return (
    heading
      .split("\n")
      .map((line) => line.trim())
      .find((line) => getHeadingLevel(line) !== null) || heading.trim()
  );
}

function toManagedLogbookSection(sectionContents: string): string {
  const trimmedSectionContents = sectionContents.trimEnd();
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

function findMarkedLogbookSectionRanges(fileLines: string[]): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== LOGBOOK_SECTION_START_MARKER) {
      continue;
    }

    const endMarkerLine = fileLines.findIndex(
      (line, index) =>
        index > i && line.trim() === LOGBOOK_SECTION_END_MARKER
    );

    if (endMarkerLine === -1) {
      continue;
    }

    ranges.push(createSectionRange(fileLines, i, endMarkerLine + 1));
    i = endMarkerLine;
  }

  return ranges;
}

function findHeadingSectionRanges(
  fileLines: string[],
  headingLine: string
): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== headingLine) {
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
        findSectionEndLine(fileLines, i, headingLevel)
      )
    );
  }

  return ranges;
}

function findGeneratedLogbookSectionRanges(fileLines: string[]): SectionRange[] {
  const ranges: SectionRange[] = [];

  for (let i = 0; i < fileLines.length; i++) {
    const headingLevel = getHeadingLevel(fileLines[i]);
    if (!headingLevel) {
      continue;
    }

    const endLine = findSectionEndLine(fileLines, i, headingLevel);
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
  headingLevel: number
): number {
  for (let i = startLine + 1; i < fileLines.length; i++) {
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
