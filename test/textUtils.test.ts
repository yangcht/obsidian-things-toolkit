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
