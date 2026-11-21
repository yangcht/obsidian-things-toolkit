import assert from "node:assert/strict";
import test from "node:test";

import {
  countThingsTasksInSection,
  LOGBOOK_SECTION_END_MARKER,
  LOGBOOK_SECTION_START_MARKER,
  updateSectionContents,
} from "../src/logbookSection";

const currentSection = [
  "### Things Daily Log",
  "",
  "#### Mindful",
  "- [x] [Task A](things:///show?id=task-a) #things/mind",
  "\t## Daily summary",
  "\t-",
  "",
  "#### Body",
  "- [x] [Task B](things:///show?id=task-b) #things/life",
].join("\n");

const oldSection = [
  "### Daily_Things3",
  "",
  "#### Mindful",
  "- [x] [Task A](things:///show?id=task-a) #things/mind",
  "\t## Daily summary",
  "\t-",
  "",
  "#### Body",
  "- [x] [Task B](things:///show?id=task-b) #things/life",
].join("\n");

const defaultSection = [
  "## Things",
  "### Mindful",
  "- [x] [Task A](things:///show?id=task-a) #things/mind",
  "\t## Daily summary",
  "\t-",
  "### Body",
  "- [x] [Task B](things:///show?id=task-b) #things/life",
].join("\n");

test("marks a newly appended logbook section", () => {
  const result = updateSectionContents("# Journal", "### Things Daily Log", currentSection);

  assert.equal(result.didChange, true);
  assert.equal(
    result.contents,
    [
      "# Journal",
      "",
      LOGBOOK_SECTION_START_MARKER,
      currentSection,
      LOGBOOK_SECTION_END_MARKER,
    ].join("\n")
  );
});

test("replaces an existing marked logbook section after a heading rename", () => {
  const fileContents = [
    "# Journal",
    "",
    LOGBOOK_SECTION_START_MARKER,
    oldSection,
    LOGBOOK_SECTION_END_MARKER,
    "",
    "Personal note",
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.match(result.contents, /### Things Daily Log/);
  assert.doesNotMatch(result.contents, /### Daily_Things3/);
  assert.match(result.contents, /Personal note/);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 1);
});

test("leaves an unchanged marked logbook section untouched", () => {
  const fileContents = [
    "# Journal",
    "",
    LOGBOOK_SECTION_START_MARKER,
    currentSection,
    LOGBOOK_SECTION_END_MARKER,
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, false);
  assert.equal(result.contents, fileContents);
});

test("consolidates unmarked legacy duplicate logbook sections", () => {
  const fileContents = [
    "# Journal",
    "",
    "## Things3",
    "#_things3",
    "",
    currentSection,
    "",
    oldSection,
    "",
    defaultSection,
    "",
    "## Notes",
    "Keep this.",
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.match(result.contents, /## Things3/);
  assert.match(result.contents, /#_things3/);
  assert.match(result.contents, /### Things Daily Log/);
  assert.doesNotMatch(result.contents, /### Daily_Things3/);
  assert.doesNotMatch(result.contents, /\n## Things\n### Mindful/);
  assert.match(result.contents, /## Notes\nKeep this\./);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 1);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-b"), 1);
});

test("uses a legacy generated section as the rename target when the new heading is absent", () => {
  const fileContents = ["# Journal", "", oldSection].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.match(result.contents, /### Things Daily Log/);
  assert.doesNotMatch(result.contents, /### Daily_Things3/);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 1);
});

test("does not treat user prose with a Things link as a generated section", () => {
  const fileContents = [
    "# Journal",
    "",
    "## Related Things",
    "Remember why this task mattered.",
    "- [x] [Task A](things:///show?id=task-a)",
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.match(result.contents, /## Related Things/);
  assert.match(result.contents, /Remember why this task mattered\./);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 2);
});

test("counts tasks in the marked logbook section after a heading rename", () => {
  const fileContents = [
    LOGBOOK_SECTION_START_MARKER,
    oldSection,
    LOGBOOK_SECTION_END_MARKER,
  ].join("\n");

  assert.equal(countThingsTasksInSection(fileContents, "### Things Daily Log"), 2);
});

function countOccurrences(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

test("preserves prose and subheadings after an unchanged managed section", () => {
  const contents = [LOGBOOK_SECTION_START_MARKER, currentSection,
    LOGBOOK_SECTION_END_MARKER, "", "Personal reflection", "#### More notes", "Keep me."].join("\n");
  const result = updateSectionContents(contents, "### Things Daily Log", currentSection);
  assert.equal(result.contents, contents);
  assert.equal(result.didChange, false);
});

test("preserves trailing notes when updating a managed section", () => {
  const suffix = "\n\nPersonal reflection\n#### More notes\nKeep me.";
  const contents = [LOGBOOK_SECTION_START_MARKER, currentSection,
    LOGBOOK_SECTION_END_MARKER].join("\n") + suffix;
  const replacement = currentSection.replace("Task A", "Updated task");
  const result = updateSectionContents(contents, "### Things Daily Log", replacement);
  assert.equal(result.contents, [LOGBOOK_SECTION_START_MARKER, replacement,
    LOGBOOK_SECTION_END_MARKER].join("\n") + suffix);
});

test("counts tasks and detects legacy sections with custom canceled marks", () => {
  const customCanceledSection = [
    "### Old Things",
    "- [-] [Canceled task](things:///show?id=task-c)",
    "- [x] [Done task](things:///show?id=task-d)",
  ].join("\n");

  assert.equal(
    countThingsTasksInSection(customCanceledSection, "### Things Daily Log"),
    2
  );

  const updatedSection = [
    "### Things Daily Log",
    "- [-] [Canceled task](things:///show?id=task-c)",
    "- [x] [Done task](things:///show?id=task-d)",
  ].join("\n");

  const result = updateSectionContents(
    ["# Journal", "", customCanceledSection].join("\n"),
    "### Things Daily Log",
    updatedSection
  );

  assert.equal(result.didChange, true);
  assert.doesNotMatch(result.contents, /### Old Things/);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-c"), 1);
});

test("ignores headings and markers inside fenced code blocks", () => {
  const fileContents = [
    "# Journal",
    "",
    "```markdown",
    LOGBOOK_SECTION_START_MARKER,
    "### Things Daily Log",
    "Example snippet",
    LOGBOOK_SECTION_END_MARKER,
    "```",
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.ok(result.contents.startsWith(fileContents));
  assert.equal(countOccurrences(result.contents, "Example snippet"), 1);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 1);
});

test("preserves personal notes after an orphaned start marker before a real marked section", () => {
  const fileContents = [
    "# Journal",
    LOGBOOK_SECTION_START_MARKER,
    "Important personal note that must survive",
    LOGBOOK_SECTION_START_MARKER,
    oldSection,
    LOGBOOK_SECTION_END_MARKER,
  ].join("\n");

  const result = updateSectionContents(
    fileContents,
    "### Things Daily Log",
    currentSection
  );

  assert.equal(result.didChange, true);
  assert.match(result.contents, /Important personal note that must survive/);
  assert.doesNotMatch(result.contents, /### Daily_Things3/);
  assert.equal(countOccurrences(result.contents, "things:///show?id=task-a"), 1);
});

test("preserves CRLF line endings cleanly and remains idempotent", () => {
  const crlfContents = [
    "# Journal",
    "",
    LOGBOOK_SECTION_START_MARKER,
    currentSection.replace(/\n/g, "\r\n"),
    LOGBOOK_SECTION_END_MARKER,
  ].join("\r\n");

  const unchanged = updateSectionContents(
    crlfContents,
    "### Things Daily Log",
    currentSection
  );
  assert.equal(unchanged.didChange, false);
  assert.equal(unchanged.contents, crlfContents);

  const appended = updateSectionContents(
    "# Journal\r\n",
    "### Things Daily Log",
    currentSection
  );
  assert.equal(appended.didChange, true);
  assert.equal(appended.contents.includes("\r\n"), true);
  assert.equal(appended.contents.replace(/\r\n/g, "").includes("\n"), false);
});
