# Things Toolkit for Obsidian

Things Toolkit connects Things3 with Obsidian daily notes. It imports completed and canceled Things Logbook items, keeps recent completion counts available in a sidebar review calendar, and lets you open the matching daily note from any calendar day.

## Features

- Sync completed and canceled Things3 Logbook items into Obsidian daily notes.
- Create missing daily notes automatically when synced Things items exist for that day.
- Repair recent history on newer macOS versions where direct database access can be blocked.
- Show a sidebar review calendar with completed-task counts, current streak, and 7-day total.
- Review a full year by default, grouped by month with ISO week numbers.
- See monthly totals, active-day counts, best day, and selected-day week/month context.
- Mark days as good, steady, or needing improvement, and save a short reflection.
- Store review ratings and reflections in each daily note under the `things_toolkit_review` frontmatter property.
- Open or create the selected daily note by clicking a calendar day or using the review detail button.

## macOS Privacy

Things Toolkit uses two access paths:

- SQLite: fast direct access to the local Things database, including checklist items, when macOS allows it.
- AppleScript: a privacy-compatible fallback through Things3 when macOS blocks direct access to another app's group container.

In Auto mode, the plugin tries SQLite first and falls back to AppleScript if macOS privacy blocks the database. The settings tab shows the current access status and includes shortcuts to Full Disk Access and Automation privacy settings.

Failed periodic syncs wait for the configured sync interval before retrying. Repair syncs are idempotent: unchanged Things sections are left untouched.

## Settings

| Setting | Purpose |
| --- | --- |
| Things access | Choose Auto, AppleScript, or SQLite only. |
| macOS privacy status | Shows whether SQLite or AppleScript is currently being used. |
| Sync frequency | Controls periodic sync interval in seconds. |
| AppleScript fallback lookback | Controls the repair window when AppleScript is used. |
| Review window | Controls how many recent days are shown and repaired. Defaults to `365`. |
| Section heading | Markdown heading where synced Things items are written. |
| Tag prefix | Prefix used for imported Things tags. |
| Include notes | Include Things task notes below each task. |
| Include project | Group project tasks under project headings instead of area headings. |

## Development

Install dependencies and run the complete local verification pipeline:

```sh
npm install
npm run build
```

The build runs type-aware linting, scheduler regression tests, TypeScript checking, and the Rollup bundle. Test plugin builds in a dedicated Obsidian vault before using them with personal notes.

## 1.6.0

- Fix external source audits that omit development-only type packages.
- Prevent rapid retry loops after failed periodic sync attempts.
- Correct project-heading precedence when project grouping is enabled.
- Add type-aware linting and scheduler regression tests to the build.

## 1.7.0

- Persist daily reviews in daily-note frontmatter so they travel with the vault.
- Migrate existing plugin-stored reviews to frontmatter once, without recreating reviews removed later.
- Keep Obsidian and Papa Parse declarations available to external source audits through registry-resolvable production dependencies.
- Restore strict unsafe-value linting and add frontmatter parsing regression tests.

## Publishing

For an Obsidian community plugin release, each GitHub release must include:

- `manifest.json`
- `main.js`
- `styles.css`

The release tag must match the `version` in `manifest.json`.
Attach these files directly to the release; do not attach `versions.json` or a zip file.

For a new release:

```sh
npm run release:create
```

For an existing release:

```sh
npm run release:upload
```

## Attribution

Things Toolkit is derived from the MIT-licensed Things Logbook plugin by Liam Cain. The MIT license notice is preserved in `LICENSE`.
