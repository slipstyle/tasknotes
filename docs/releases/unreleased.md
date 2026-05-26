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
