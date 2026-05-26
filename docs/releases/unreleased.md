# TaskNotes - Unreleased

<!--

**Added** for new features.
**Changed** for changes in existing functionality.
**Deprecated** for soon-to-be removed features.
**Removed** for now removed features.
**Fixed** for any bug fixes.
**Security** in case of vulnerabilities.

Always acknowledge contributors and those who report issues.

Example:

```
## Fixed

- (#768) Fixed calendar view appearing empty in week and day views due to invalid time configuration values
  - Added time validation in settings UI with proper error messages and debouncing
  - Prevents "Cannot read properties of null (reading 'years')" error from FullCalendar
  - Thanks to @userhandle for reporting and help debugging
```

-->

## Fixed

- (#982, #1947) Restored larger mobile task-card typography and let secondary card icons wrap below the task details when they no longer fit comfortably on mobile.
  - Thanks to @3zra47 for reporting the font-size regression, @chrsdk and @scottaltham-payroc for confirming the mobile font-size issue, and @Jomo94 for reporting the mobile card layout problem.

- Fixed CalDAV export crash when scheduled date has malformed time format
  - Added defensive validation in formatLocalTime and formatLocalEndTime to handle corrupted time data (e.g., "T1000" without colon separator)
  - Fixed bug in recurrence.ts that was generating invalid time format "T1000" instead of "T10:00" when building next scheduled occurrence
  - Added validation in recurrence.ts to catch malformed scheduled/due times and log warnings instead of crashing

- Fixed CalDAV sync incorrectly treating existing events as new
  - Changed from UID-based matching to URL-based matching for sync
  - More reliable than extracting UIDs from ICS content (which had regex mismatch issues)
  - PROPFIND response had mismatched href vs calendar-data counts, causing UID extraction failures
  - Now correctly shows Create: 0, Update: N instead of spurious creates/deletes on each sync

## Added

- New ICS export filtering using Bases views
  - Filter exported tasks using a Bases view filter configuration
  - Enable via Settings > Integrations > Automatic ICS export > Filter by Bases View
  - Specify the path to a .base file, optionally with #ViewName for specific views
  - Root-level and view-specific filters are combined (AND logic)
  - Related to #773

- New "Export recurring tasks as series" setting for ICS export
  - When enabled, recurring tasks include RRULE in ICS export
  - Calendar apps display recurring tasks as repeating events (not single instances)
  - Uses original recurrence start date (DTSTART) for full history
  - Respects "Use task duration for event length" setting for DTEND calculation
  - Output follows valid RFC 5545 format

- New "Include reminders as VALARM" setting for ICS export
  - When enabled, task reminders are exported as VALARM blocks inside each VEVENT
  - Calendar apps that support VALARM will display reminder alerts for exported tasks
  - Enable via Settings > Integrations > Automatic ICS export > Include reminders as VALARM

- New "Export format" setting for ICS and CalDAV export
  - Choose between VEVENT (calendar events) and VTODO (task items) format
  - VEVENT is the default for backward compatibility with calendar apps
  - VTODO is supported by task managers such as Todoist, TickTick, and Nextcloud Tasks
  - Available in both ICS auto-export and CalDAV export settings

- CalDAV timezone handling with TZID and VTIMEZONE
  - Uses explicit timezone via TZID format, matching Nextcloud's native ICS format
  - Auto-detects user's timezone via Intl.DateTimeFormat().resolvedOptions().timeZone
  - Generates VTIMEZONE block for timezone definition
  - Example output: `DTSTART;TZID=America/Toronto:20260407T070000`
  - Times display correctly in Nextcloud without manual offset calculation

- New setting to use recurrence time for next occurrence
  - Controls whether completed/skipped recurring tasks use the recurrence rule's DTSTART time or the current scheduled time
  - When enabled, next occurrence resets to recurrence's default time instead of inheriting rescheduled time
  - Supports the "default day" workflow: plan recurring tasks with default times, reschedule specific days without affecting future defaults
  - Enable via Settings > Features > Recurring Tasks > Use recurrence time for next occurrence
  - Default: OFF (maintains backward compatibility)

- New CalDAV export integration
  - Push tasks directly to a CalDAV server (Nextcloud, ownCloud, and compatible servers)
  - URL-based sync: calculates creates, updates, and deletes based on stored event URLs
  - Stores `caldavEventId` (UUID), `caldavEventUrl`, and `caldavLastSynced` in task frontmatter
  - Field names are configurable via the FieldMapper system (same as Google Calendar fields)
  - Deletes orphaned CalDAV events when corresponding tasks are removed from TaskNotes
  - Handles Nextcloud trashbin 403 conflicts gracefully
  - Enable via Settings > Integrations > CalDAV Export

- CalDAV export settings
  - Server URL, username, and password credential fields (auto-saved on change)
  - Calendar path for the target collection
  - Configurable sync interval (independent from ICS auto-export interval)
  - "Test Connection" button with live feedback
  - "Export Now" button for on-demand sync
  - Optional RRULE export for recurring tasks
  - Optional Bases view filter (separate from ICS filter)
  - Debug logging toggle for troubleshooting sync issues

- CalDAV concurrent export setting
  - Controls number of parallel requests when pushing events to CalDAV
  - Default: 5, range: 1–100
  - Higher values speed up large exports; lower values suit slower servers
