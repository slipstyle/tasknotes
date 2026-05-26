# ICS Export

TaskNotes can export your tasks to an ICS file, allowing you to subscribe to your tasks in external calendar applications like Google Calendar, Apple Calendar, Outlook, and others.

## Overview

The automatic ICS export feature periodically exports your tasks to an ICS file that can be:

- Added as a calendar subscription in any calendar application
- Used with calendar tools like caldav
- Shared with others who can subscribe to the feed

The exported ICS file follows the RFC 5545 standard for calendar data, ensuring broad compatibility with calendar applications.

## Settings

Configure ICS export under **Settings → TaskNotes → Integrations → Automatic ICS export**:

### Enable Automatic Export

Toggle to enable or disable automatic export. When enabled, tasks are exported on a schedule.

### Export File Path

Specify the vault-relative path where the ICS file is written. Default: `tasknotes-calendar.ics`

### Export Interval

How often the ICS file is updated. Options range from every 5 minutes to every 24 hours.

### Use Duration for Event Length

When enabled, exported calendar events use the task's time estimate as the event duration instead of using the due date as the end time.

- **Off (default)**: Event starts at scheduled date/time, ends at due date/time (or 1 hour if no due date)
- **On**: Event starts at scheduled date/time, duration equals time estimate

### Export Recurring Tasks as Series

When enabled, recurring tasks include an RRULE in the exported ICS event, causing calendar applications to display them as repeating events rather than single instances.

#### How It Works

When enabled, the ICS export:

1. **Extracts the original recurrence start** (DTSTART) from the task's recurrence setting
2. **Sets DTSTART** to when the recurrence originally started (preserving history)
3. **Calculates DTEND** based on the "Use task duration for event length" setting:
    - **Off**: Uses due date as end time (or +1 hour if no due date)
    - **On**: Uses original DTSTART + time estimate as duration
4. **Adds RRULE** with the recurrence rule (e.g., `FREQ=WEEKLY;BYDAY=SA`)
5. **Valid RFC 5545 format**: The RRULE is formatted correctly without embedded DTSTART

#### Example Output

For a weekly task that started on December 20, 2025:

```
DTSTART;VALUE=DATE:20251220
DTEND;VALUE=DATE:20251221
RRULE:FREQ=WEEKLY;BYDAY=SA
```

This tells the calendar to show the task every Saturday from December 20, 2025 forward (or until the UNTIL date if set).

#### Benefits

- **Full history**: Calendar shows all past occurrences, not just current/future
- **Proper duration**: Each occurrence respects the task's time estimate
- **Calendar app support**: Works with Google Calendar, Apple Calendar, Outlook, Nextcloud, and other ICS-compatible calendars

## Filter by Bases View

The filter feature allows you to export only a subset of your tasks based on criteria defined in a Bases view.

### Enabling the Filter

1. Enable "Filter tasks using Bases view" in Settings → TaskNotes → Integrations → Automatic ICS export
2. Enter the path to a `.base` file, optionally with a specific view name

### Path Format

The path can reference:

- The entire .base file (uses the first view's filters)
- A specific view within the .base file

| Format      | Example                                          | Description                  |
| ----------- | ------------------------------------------------ | ---------------------------- |
| File only   | `TaskNotes/Views/agenda-default.base`            | Uses first view's filters    |
| File + View | `TaskNotes/Views/agenda-default.base#ICS Export` | Uses specific view's filters |

### How Filters Work

#### Combining Root and View Filters

When you specify a view, the filter combines **both** the root-level filters from the .base file AND the view-specific filters. Tasks must match **both** filter sets.

For example, given this .base file:

```yaml
# Root-level filters (apply to ALL views)
filters:
    and:
        - file.hasTag("taskNote")
        - '!file.folder.startsWith("_Templates")'

views:
    - name: ICS Export
      filters:
          or:
              - and:
                    - "!scheduled.isEmpty()"
```

The exported tasks must satisfy:

- **Root filters**: Has tag "taskNote" AND folder doesn't start with "\_Templates"
- **AND** **View filters**: Has a scheduled date

#### Supported Filter Expressions

The filter parser supports these expression formats:

| Pattern           | Example                   | Description                            |
| ----------------- | ------------------------- | -------------------------------------- |
| Not empty         | `!scheduled.isEmpty()`    | Tasks where scheduled is not empty     |
| Is empty          | `scheduled.isEmpty()`     | Tasks where scheduled is empty         |
| Has tag           | `file.hasTag("taskNote")` | Tasks with specific tag                |
| Contains          | `tags.contains("work")`   | Tasks where tags contain value         |
| Equality          | `status == "todo"`        | Tasks with exact status match          |
| Not equal         | `status != "done"`        | Tasks with different status            |
| Not equal (empty) | `status != ""`            | Tasks where status is not empty        |
| Comparison        | `due <= today()`          | Tasks with due date before/after today |
| Comparison        | `due > today()`           | Tasks with due date after today        |
| Comparison        | `priority == "high"`      | Tasks with specific priority           |

#### Property Names

Filter expressions can use these property names:

| Bases Property     | TaskNotes Field | Notes            |
| ------------------ | --------------- | ---------------- |
| `file.hasTag("x")` | Tags            | Checks for tag   |
| `file.folder`      | Path            | File folder path |
| `note.status`      | Status          | Task status      |
| `note.priority`    | Priority        | Task priority    |
| `note.due`         | Due             | Due date         |
| `note.scheduled`   | Scheduled       | Scheduled date   |
| `note.projects`    | Projects        | Linked projects  |
| `note.contexts`    | Contexts        | Task contexts    |
| `note.tags`        | Tags            | Task tags        |

#### Date Functions

The filter supports these date functions:

- `today()` - Current date
- `now()` - Current date/time

### Creating a Filter View

1. Open or create a `.base` file in your vault
2. Add filters at the root level (applies to all views)
3. Optionally add specific views with their own filters
4. Reference the file in the ICS export settings

Example .base file structure:

```yaml
# Root filters - apply to all views
filters:
  and:
    - file.hasTag("taskNote")
    - '!file.folder.startsWith("_Templates")'

views:
  - name: ICS Export
    filters:
      or:
        - and:
            - "!scheduled.isEmpty()
            - due <= today()
```

## Examples

### Export Only Scheduled Tasks

```yaml
filters:
    or:
        - and:
              - "!scheduled.isEmpty()"
```

### Export Tasks Due Today or Overdue

```yaml
filters:
    and:
        - "!due.isEmpty()"
        - "due <= today()"
```

### Export High Priority Tasks

```yaml
filters:
    and:
        - note.priority == "high"
        - note.status != "done"
```

### Export Tasks in Specific Project

```yaml
filters:
    and:
        - note.projects.contains("Work")
```

## Troubleshooting

### No Tasks Are Exported

If the ICS file is empty or contains no events:

1. **Check if you have tasks**: Ensure your vault contains tasks with the configured task tag
2. **Verify export is enabled**: Check "Enable Automatic Export" is turned on in settings
3. **Check the export path**: Verify the file path is valid and writable
4. **Check filter configuration**: If using Bases filter, verify the path is correct and the view exists

### All Tasks Are Exported (Filter Not Working)

If you enabled the filter but all tasks are still exported:

1. **Verify filter path**: Check that the .base file path is correct
2. **Check view name**: If using a specific view, ensure the view name matches exactly
3. **Examine filter syntax**: Verify filter expressions use supported patterns
4. **Check logs**: Open developer console (Ctrl+Shift+I) and check for filter-related warnings

### Filter Expressions Not Working

If specific filter expressions aren't working:

1. **Use supported patterns**: Ensure expressions match the supported formats
2. **Check string formatting**: Filter expressions must be in quotes when using string values
3. **Verify property names**: Ensure property names match TaskNotes field names

### Calendar Not Updating

If your calendar application isn't showing updated events:

1. **Check subscription URL**: Verify the ICS file URL is correct
2. **Refresh the subscription**: Most calendars need manual refresh after file changes
3. **Check refresh interval**: Calendar apps fetch on their own schedule
4. **Try re-adding**: Remove and re-add the calendar subscription

### Recurring Tasks Show as Single Events

If recurring tasks appear as one-time events:

1. **Check the setting**: Ensure "Export recurring tasks as series" is enabled
2. **Verify recurrence is set**: Check the task actually has recurrence configured
3. **Check calendar support**: Some calendar applications have limited RRULE support
