# Code quality review — 2.1.1

Reviewed on 2026-09-05: sync orchestration, Things access, SQLite execution,
Markdown rendering and replacement, review persistence and UI, settings,
scheduling, tests, dependencies, and GitHub release configuration.

## Assessment

The project has a useful foundation: strict TypeScript, type-aware linting,
automated release builds, and pure helpers for several sensitive operations.
The main gaps are host integration coverage and edge cases around asynchronous
updates. This review prioritizes preventing personal-note data loss.

## Fixed in this release

- **High — Text after managed sections could be deleted.** Heading-based
  replacement ranges overlapped explicit marker ranges and extended past the
  closing marker. Headings inside managed blocks no longer determine deletion
  boundaries. Two regression tests reproduced the loss before the fix.
- **High — Sync could overwrite newer note contents.** Closed-note updates now
  compute their replacement inside `vault.process`. Open-note updates use the
  current editor buffer, without an intervening asynchronous read. Integration
  tests use a mocked Obsidian boundary to exercise both paths and idempotence.
- **Medium — Valid project/area names could break grouping.** The grouping map
  now has no inherited properties. Tests cover `__proto__`, `constructor`, and
  `toString`, including repeated names.
- **Medium — Test files were excluded from test type checking.** The test
  configuration inherited the source configuration's test exclusion. It now
  explicitly includes tests without that exclusion.
- **Dependency maintenance.** Updated only affected transitive development
  dependencies: brace-expansion, fast-uri, and js-yaml. The initial npm audit
  reported three high-severity affected packages; the updated lockfile audit
  reports zero vulnerabilities. This is an advisory check, not a security guarantee.

## Follow-up findings

These existing issues were identified by code inspection and are not fixed in
2.1.1. They need dedicated fixtures or host-level validation.

1. **High — SQLite pagination may omit records at a batch boundary.**
   `src/things.ts` advances the cursor using only the last stop date, with a
   strict `>` filter. If a full batch ends among rows sharing that date, the
   remaining rows are skipped. Joined tag rows can also split a task across
   the boundary. Add a fixture exceeding 1,000 rows with tied timestamps and
   test a stable pagination strategy before changing database retrieval.
2. **Medium — Checklist retrieval is based on the checklist completion date.**
   `src/things.ts` can omit unchecked items and items completed before the
   repair cutoff even when their parent task is included. Test retrieval by
   parent task against a representative Things schema.
3. **Medium — Background sync needs lifecycle/error isolation.**
   `src/index.ts` has no unload handler for its manually scheduled timeout,
   and a failure while refreshing review state in sync's `finally` block can
   prevent the next sync from being scheduled. Add host-level tests for
   disabling the plugin during sync and for failed vault reads.
4. **Medium — Unsaved reflection drafts can disappear on a view refresh.**
   `src/reviewView.ts` rebuilds the textarea from saved state. A rating change,
   date change, or sync refresh can discard a draft. Preserve drafts per date
   and verify navigation and save behavior in Obsidian.

## Verification boundary

Automated coverage exercises Markdown replacement, the mocked editor/vault
write paths, grouping, review-frontmatter parsing, calendar scrolling, and
scheduler delay calculations. It does not exercise the real Things database,
macOS privacy prompts, or the Obsidian UI. No personal vault or Things data was
modified during this review.
