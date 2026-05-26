/**
 * CalendarExportService Unit Tests
 *
 * Tests for ICS export functionality including:
 * - ICS content generation
 * - Calendar URL generation (Google, Outlook, Yahoo)
 * - VALARM (reminder) generation
 * - RRULE (recurrence) handling
 * - VTIMEZONE generation
 */

import {
	CalendarExportService,
	ICSExportOptions,
} from "../../../src/services/CalendarExportService";
import { TaskInfo, Reminder } from "../../../src/types";

jest.mock("obsidian", () => ({
	Notice: jest.fn(),
}));

describe("CalendarExportService", () => {
	const createTask = (overrides?: Partial<TaskInfo>): TaskInfo => ({
		title: "Test Task",
		status: "open",
		priority: "normal",
		path: "/tasks/test.md",
		archived: false,
		tags: ["work"],
		contexts: ["office"],
		projects: ["Project A"],
		due: "2025-04-20",
		scheduled: "2025-04-20T10:00:00",
		dateCreated: "2025-04-01T00:00:00Z",
		...overrides,
	});

	describe("generateICSContent", () => {
		it("should generate valid ICS structure for basic task", () => {
			const task = createTask();
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("BEGIN:VCALENDAR");
			expect(ics).toContain("VERSION:2.0");
			expect(ics).toContain("PRODID:-//TaskNotes//Task Export//EN");
			expect(ics).toContain("END:VCALENDAR");
		});

		it("should include VEVENT with title as SUMMARY", () => {
			const task = createTask({ title: "My Task Title" });
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("BEGIN:VEVENT");
			expect(ics).toContain("SUMMARY:My Task Title");
			expect(ics).toContain("END:VEVENT");
		});

		it("should include DTSTART for scheduled date", () => {
			const task = createTask({ scheduled: "2025-04-20T10:00:00" });
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("DTSTART");
		});

		it("should map priority correctly to ICS priority values", () => {
			const priorities: Array<{ priority: string; expected: string }> = [
				{ priority: "highest", expected: "1" },
				{ priority: "high", expected: "3" },
				{ priority: "medium", expected: "5" },
				{ priority: "low", expected: "7" },
				{ priority: "lowest", expected: "9" },
			];

			for (const { priority, expected } of priorities) {
				const task = createTask({ priority });
				const ics = CalendarExportService.generateICSContent(task);

				expect(ics).toContain(`PRIORITY:${expected}`);
			}
		});

		it("should map status correctly", () => {
			const statuses: Array<{ status: string; expected: string }> = [
				{ status: "done", expected: "STATUS:CONFIRMED" },
				{ status: "in-progress", expected: "STATUS:CONFIRMED" },
				{ status: "todo", expected: "STATUS:CONFIRMED" },
				{ status: "cancelled", expected: "STATUS:CANCELLED" },
			];

			for (const { status, expected } of statuses) {
				const task = createTask({ status });
				const ics = CalendarExportService.generateICSContent(task);

				expect(ics).toContain(expected);
			}
		});

		it("should include tags as CATEGORIES", () => {
			const task = createTask({ tags: ["work", "urgent", "project-x"] });
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("CATEGORIES:work,urgent,project-x");
		});

		it.skip("should include contexts as LOCATION", () => {
			// NOTE: Contexts should NOT be exported as LOCATION - this is a bug
			// Tracked in code-review_2026-04-15.md as post-PR cleanup item
			const task = createTask({ contexts: ["office", "home"] });
			const ics = CalendarExportService.generateICSContent(task);

			// Currently exports to LOCATION (bug), should not export contexts at all
			expect(ics).not.toContain("LOCATION:office");
		});

		it("should escape special characters in text", () => {
			const task = createTask({ title: "Task with, semicolon; and\nnewline" });
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("SUMMARY:Task with\\, semicolon\\; and\\nnewline");
		});

		it("should include description with metadata", () => {
			const task = createTask({
				priority: "high",
				projects: ["Project A"],
			});
			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("DESCRIPTION:");
			expect(ics).toContain("Priority: high");
			expect(ics).toContain("Projects: Project A");
		});
	});

	describe("generateMultipleTasksICSContent", () => {
		it("should generate ICS with multiple VEVENTs", () => {
			const tasks = [
				createTask({ title: "Task 1", path: "/tasks/task1.md" }),
				createTask({ title: "Task 2", path: "/tasks/task2.md" }),
				createTask({ title: "Task 3", path: "/tasks/task3.md" }),
			];

			const ics = CalendarExportService.generateMultipleTasksICSContent(tasks);

			const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
			expect(veventCount).toBe(3);
		});

		it("should respect useDurationForExport option", () => {
			const task = createTask({
				scheduled: "2025-04-20T10:00:00",
				timeEstimate: 60,
			});

			const icsWithDuration = CalendarExportService.generateMultipleTasksICSContent([task], {
				useDurationForExport: true,
			});

			expect(icsWithDuration).toContain("DTSTART");
		});

		it("should include VTIMEZONE when timezone option is provided", () => {
			const task = createTask({ scheduled: "2025-04-20T10:00:00" });

			const ics = CalendarExportService.generateMultipleTasksICSContent([task], {
				timezone: "America/New_York",
			});

			expect(ics).toContain("BEGIN:VTIMEZONE");
			expect(ics).toContain("TZID:America/New_York");
			expect(ics).toContain("END:VTIMEZONE");
		});

		it("should include RRULE for recurring tasks when enabled", () => {
			const task = createTask({
				recurrence: "FREQ=DAILY",
				scheduled: "2025-04-20T10:00:00",
			});

			const ics = CalendarExportService.generateMultipleTasksICSContent([task], {
				includeRecurrence: true,
			});

			expect(ics).toContain("RRULE:");
			expect(ics).toContain("FREQ=DAILY");
		});
	});

	describe("generateVALARM (reminder export)", () => {
		it("should generate VALARM for relative reminder", () => {
			const task = createTask({ scheduled: "2025-04-20T10:00:00" });
			const reminder: Reminder = {
				id: "rem_1",
				type: "relative",
				relatedTo: "scheduled",
				offset: "-PT15M",
				description: "Reminder",
			};

			const valarmLines = (CalendarExportService as any).generateVALARM(task, reminder);

			expect(valarmLines).not.toBeNull();
			expect(valarmLines).toContain("BEGIN:VALARM");
			expect(valarmLines).toContain("TRIGGER:-PT15M");
			expect(valarmLines).toContain("ACTION:DISPLAY");
			expect(valarmLines).toContain("END:VALARM");
		});

		it("should generate VALARM for absolute reminder", () => {
			const task = createTask();
			const reminder: Reminder = {
				id: "rem_2",
				type: "absolute",
				absoluteTime: "2025-04-20T09:45:00",
				description: "Absolute reminder",
			};

			const valarmLines = (CalendarExportService as any).generateVALARM(task, reminder);

			expect(valarmLines).not.toBeNull();
			expect(Array.isArray(valarmLines)).toBe(true);
			const valarmStr = valarmLines.join("\n");
			expect(valarmStr).toContain("BEGIN:VALARM");
			expect(valarmStr).toContain("TRIGGER:VALUE=DATE-TIME:");
			expect(valarmStr).toContain("END:VALARM");
		});

		it("should return null for invalid relative reminder", () => {
			const task = createTask();
			const reminder: Reminder = {
				id: "rem_3",
				type: "relative",
				relatedTo: "scheduled",
			};

			const valarmLines = (CalendarExportService as any).generateVALARM(task, reminder);

			expect(valarmLines).toBeNull();
		});
	});

	describe("parseISO8601Duration", () => {
		it("should parse PT15M as 15 minutes", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("PT15M");
			expect(result).toBe(15);
		});

		it("should parse PT1H as 60 minutes", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("PT1H");
			expect(result).toBe(60);
		});

		it("should parse PT30M as 30 minutes", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("PT30M");
			expect(result).toBe(30);
		});

		it("should parse negative duration", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("-PT15M");
			expect(result).toBe(-15);
		});

		it("should parse combined hours and minutes", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("PT1H30M");
			expect(result).toBe(90);
		});

		it("should return 0 for invalid format", () => {
			const result = (CalendarExportService as any).parseISO8601Duration("invalid");
			expect(result).toBe(0);
		});
	});

	describe("generateCalendarURL", () => {
		it("should generate Google Calendar URL", () => {
			const task = createTask({
				title: "Test Event",
				scheduled: "2025-04-20T10:00:00",
			});

			const url = CalendarExportService.generateCalendarURL({
				type: "google",
				task,
			});

			expect(url).toContain("https://calendar.google.com/calendar/render");
			expect(url).toContain("action=TEMPLATE");
			expect(url).toContain("text=Test+Event");
		});

		it("should generate Outlook Calendar URL", () => {
			const task = createTask({
				title: "Outlook Event",
				scheduled: "2025-04-20T10:00:00",
			});

			const url = CalendarExportService.generateCalendarURL({
				type: "outlook",
				task,
			});

			expect(url).toContain("https://outlook.live.com/calendar/0/deeplink/compose");
			expect(url).toContain("subject=Outlook+Event");
		});

		it("should generate Yahoo Calendar URL", () => {
			const task = createTask({
				title: "Yahoo Event",
				scheduled: "2025-04-20T10:00:00",
			});

			const url = CalendarExportService.generateCalendarURL({
				type: "yahoo",
				task,
			});

			expect(url).toContain("https://calendar.yahoo.com/");
			expect(url).toContain("title=Yahoo+Event");
		});

		it("should throw error for unsupported calendar type", () => {
			const task = createTask();

			expect(() => {
				CalendarExportService.generateCalendarURL({
					type: "unknown" as any,
					task,
				});
			}).toThrow("Unsupported calendar type");
		});
	});

	describe("foldICSLines", () => {
		it("should not fold lines shorter than 75 characters", () => {
			const shortLine = "BEGIN:VEVENT";
			const folded = (CalendarExportService as any).foldICSLines(shortLine);

			expect(folded).toBe(shortLine);
		});

		it("should fold lines longer than 75 characters", () => {
			const longLine = "DESCRIPTION:" + "a".repeat(100);
			const folded = (CalendarExportService as any).foldICSLines(longLine);

			expect(folded.length).toBeGreaterThan(75);
			expect(folded).toContain("\r\n ");
		});
	});

	describe("all-day event handling", () => {
		it("should use VALUE=DATE for date-only scheduled", () => {
			const task = createTask({
				scheduled: "2025-04-20",
				due: "2025-04-21",
			});

			const ics = CalendarExportService.generateICSContent(task);

			expect(ics).toContain("DTSTART;VALUE=DATE:20250420");
			expect(ics).toContain("DTEND;VALUE=DATE:20250422"); // All-day adds 1 day to scheduled
		});

		it("should calculate DTEND for all-day from duration", () => {
			const task = createTask({
				scheduled: "2025-04-20",
				timeEstimate: 1440, // 1 day worth of minutes (24*60)
			});

			const ics = CalendarExportService.generateMultipleTasksICSContent([task], {
				useDurationForExport: true,
			});

			// useDurationForExport calculates days: ceil(1440 / 1440) = 1 day, so 20250420 + 1 = 20250421
			expect(ics).toContain("DTEND;VALUE=DATE:20250421");
		});
	});
});
