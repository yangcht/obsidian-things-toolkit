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
- Open or create the selected daily note by clicking a calendar day or using the review detail button.

## macOS Privacy

Things Toolkit uses two access paths:

- SQLite: fast direct access to the local Things database, including checklist items, when macOS allows it.
- AppleScript: a privacy-compatible fallback through Things3 when macOS blocks direct access to another app's group container.

In Auto mode, the plugin tries SQLite first and falls back to AppleScript if macOS privacy blocks the database. The settings tab shows the current access status and includes shortcuts to Full Disk Access and Automation privacy settings.

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
| Include project | Group by project when available. |

## Publishing

For an Obsidian community plugin release, each GitHub release must include:

- `manifest.json`
- `main.js`
- `styles.css`

The release tag must match the `version` in `manifest.json`.

## Attribution

Things Toolkit is derived from the MIT-licensed Things Logbook plugin by Liam Cain. The MIT license notice is preserved in `LICENSE`.
