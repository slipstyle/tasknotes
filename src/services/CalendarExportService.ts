import { Notice } from "obsidian";
import { TaskInfo, Reminder } from "../types";
import { format, parseISO } from "date-fns";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import type { TranslationKey } from "../i18n";
import { addDTSTARTToRecurrenceRule } from "../utils/helpers";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/CalendarExportService" });

export interface CalendarURLOptions {
	type: "google" | "outlook" | "yahoo" | "ics";
	task: TaskInfo;
	useScheduledAsDue?: boolean; // If task has no due date, use scheduled as end time
}

export interface ICSExportOptions {
	useDurationForExport?: boolean; // Use timeEstimate (duration) instead of due date for DTEND
	excludeArchived?: boolean; // Exclude archived tasks from multi-task exports
	excludeCompleted?: boolean; // Exclude completed tasks from multi-task exports
	completedStatuses?: string[]; // Status values considered completed when excludeCompleted is enabled
	requireDueDate?: boolean; // Only include tasks with a due date in multi-task exports
	requireScheduledDate?: boolean; // Only include tasks with a scheduled date in multi-task exports
	includeObsidianLink?: boolean; // Include an obsidian:// link back to the source task note
	vaultName?: string; // Vault name used when includeObsidianLink is enabled
	includeRecurrence?: boolean; // Add RRULE to recurring tasks
	includeReminders?: boolean; // Add VALARMs for task reminders
	timezone?: string; // IANA timezone for CalDAV (e.g., "America/Toronto") - adds TZID + VTIMEZONE
	exportFormat?: "vevent" | "vtodo"; // Export as calendar events or task items (default: "vevent")
}

export interface ICSDownloadFile {
	content: string;
	filename: string;
	taskCount: number;
}

type TranslateFn = (key: TranslationKey, variables?: Record<string, any>) => string;
type VEventStatus = "TENTATIVE" | "CONFIRMED" | "CANCELLED";

interface ICSDateProperties {
	startLine: string | null;
	endLine: string | null;
}

export class CalendarExportService {
	/**
	 * Generate a calendar URL for adding a task as an event
	 */
	static generateCalendarURL(options: CalendarURLOptions): string {
		const { type, task, useScheduledAsDue = true } = options;

		switch (type) {
			case "google":
				return this.generateGoogleCalendarURL(task, useScheduledAsDue);
			case "outlook":
				return this.generateOutlookCalendarURL(task, useScheduledAsDue);
			case "yahoo":
				return this.generateYahooCalendarURL(task, useScheduledAsDue);
			case "ics":
				return this.generateICSDownloadURL(task);
			default:
				throw new Error(`Unsupported calendar type: ${type}`);
		}
	}

	/**
	 * Open calendar URL in browser
	 */
	static openCalendarURL(options: CalendarURLOptions, translate?: TranslateFn): void {
		try {
			const url = this.generateCalendarURL(options);
			window.open(url, "_blank");
		} catch (error) {
			console.error("Failed to generate calendar URL:", error);
			new Notice(
				translate
					? translate("services.calendarExport.notices.generateLinkFailed")
					: "Failed to generate calendar link"
			);
		}
	}

	/**
	 * Generate Google Calendar URL
	 * Format: https://calendar.google.com/calendar/render?action=TEMPLATE&text=...
	 */
	private static generateGoogleCalendarURL(task: TaskInfo, useScheduledAsDue: boolean): string {
		const baseURL = "https://calendar.google.com/calendar/render";
		const params = new URLSearchParams();

		params.append("action", "TEMPLATE");
		params.append("text", task.title);

		// Handle dates
		const dates = this.formatGoogleDates(task, useScheduledAsDue);
		if (dates) {
			params.append("dates", dates);
		}

		// Add description
		const description = this.buildDescription(task);
		if (description) {
			params.append("details", description);
		}

		// Add location from contexts
		if (task.contexts && task.contexts.length > 0) {
			params.append("location", task.contexts.join(", "));
		}

		return `${baseURL}?${params.toString()}`;
	}

	/**
	 * Generate Outlook Calendar URL
	 * Format: https://outlook.live.com/calendar/0/deeplink/compose?...
	 */
	private static generateOutlookCalendarURL(task: TaskInfo, useScheduledAsDue: boolean): string {
		const baseURL = "https://outlook.live.com/calendar/0/deeplink/compose";
		const params = new URLSearchParams();

		params.append("subject", task.title);

		// Handle dates
		const { startISO, endISO } = this.getTaskDateRange(task, useScheduledAsDue);
		if (startISO) {
			params.append("startdt", startISO);
		}
		if (endISO) {
			params.append("enddt", endISO);
		}

		// Add description
		const description = this.buildDescription(task);
		if (description) {
			params.append("body", description);
		}

		// Add location from contexts
		if (task.contexts && task.contexts.length > 0) {
			params.append("location", task.contexts.join(", "));
		}

		params.append("path", "/calendar/action/compose");
		params.append("rru", "addevent");

		return `${baseURL}?${params.toString()}`;
	}

	/**
	 * Generate Yahoo Calendar URL
	 * Format: https://calendar.yahoo.com/?v=60&title=...
	 */
	private static generateYahooCalendarURL(task: TaskInfo, useScheduledAsDue: boolean): string {
		const baseURL = "https://calendar.yahoo.com/";
		const params = new URLSearchParams();

		params.append("v", "60"); // Required parameter
		params.append("title", task.title);

		// Handle dates (Yahoo uses YYYYMMDDTHHmmss format)
		const { startYahoo, endYahoo } = this.getYahooDateFormat(task, useScheduledAsDue);
		if (startYahoo) {
			params.append("st", startYahoo);
		}
		if (endYahoo) {
			params.append("et", endYahoo);
		}

		// Add description
		const description = this.buildDescription(task);
		if (description) {
			params.append("desc", description);
		}

		// Add location from contexts
		if (task.contexts && task.contexts.length > 0) {
			params.append("in_loc", task.contexts.join(", "));
		}

		return `${baseURL}?${params.toString()}`;
	}

	/**
	 * Generate ICS download URL (data URL)
	 */
	private static generateICSDownloadURL(task: TaskInfo): string {
		const icsContent = this.generateICSContent(task);
		const encodedContent = encodeURIComponent(icsContent);
		return `data:text/calendar;charset=utf8,${encodedContent}`;
	}

	/**
	 * Generate ICS file content
	 */
	static generateICSContent(task: TaskInfo, options?: ICSExportOptions): string {
		const uid = `${task.path.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}@tasknotes`;
		const now = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "");

		const lines = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//TaskNotes//Task Export//EN",
			"CALSCALE:GREGORIAN",
			"METHOD:PUBLISH",
			"BEGIN:VEVENT",
			`UID:${uid}`,
			`DTSTAMP:${now}`,
		];

		// Add title
		lines.push(`SUMMARY:${this.escapeICSText(task.title)}`);

		// Add dates
		const { startLine, endLine } = this.getICSDateProperties(task, true, options);
		if (startLine) {
			lines.push(startLine);
		}
		if (endLine) {
			lines.push(endLine);
		}

		// Add description
		const description = this.buildDescription(task, options);
		if (description) {
			lines.push(`DESCRIPTION:${this.escapeICSText(description)}`);
		}

		// Add categories from tags and contexts (contexts prefixed with @)
		const categories = [
			...(task.tags ?? []).map((t) => this.escapeICSText(t)),
			...(task.contexts ?? []).map((c) => this.escapeICSText(`@${c}`)),
		];
		if (categories.length > 0) {
			lines.push(`CATEGORIES:${categories.join(",")}`);
		}

		// Map priority (ICS uses 1-9, with 1 being highest)
		if (task.priority) {
			const priorityMap: Record<string, string> = {
				highest: "1",
				high: "3",
				medium: "5",
				low: "7",
				lowest: "9",
			};
			const icsPriority = priorityMap[task.priority] || "5";
			lines.push(`PRIORITY:${icsPriority}`);
		}

		// Map status — VEVENT uses TENTATIVE/CONFIRMED/CANCELLED
		if (task.status) {
			lines.push(`STATUS:${this.getVEventStatus(task.status)}`);
		}

		lines.push("END:VEVENT");
		lines.push("END:VCALENDAR");

		return lines.join("\r\n");
	}

	/**
	 * Build description text from task
	 */
	private static buildDescription(task: TaskInfo, options?: ICSExportOptions): string {
		const parts: string[] = [];

		// Add metadata
		const metadata: string[] = [];

		if (task.priority) {
			metadata.push(`Priority: ${task.priority}`);
		}

		if (task.status) {
			metadata.push(`Status: ${task.status}`);
		}

		if (task.projects && task.projects.length > 0) {
			metadata.push(`Projects: ${task.projects.join(", ")}`);
		}

		if (task.tags && task.tags.length > 0) {
			metadata.push(`Tags: ${task.tags.join(", ")}`);
		}

		if (task.contexts && task.contexts.length > 0) {
			metadata.push(`Contexts: ${task.contexts.join(", ")}`);
		}

		if (task.timeEstimate) {
			metadata.push(`Estimated time: ${task.timeEstimate} minutes`);
		}

		if (metadata.length > 0) {
			parts.push(...metadata);
		}

		// Add note about source
		if (parts.length > 0) parts.push("");
		parts.push(`Exported from TaskNotes: ${task.path}`);

		// Add Obsidian URI link when vault name is provided
		if (options?.includeObsidianLink && options?.vaultName) {
			const uri = `obsidian://open?vault=${encodeURIComponent(options.vaultName)}&file=${encodeURIComponent(task.path)}`;
			parts.push(`Open in Obsidian: ${uri}`);
		}

		return parts.join("\n");
	}

	/**
	 * Format dates for Google Calendar (YYYYMMDDTHHmmssZ/YYYYMMDDTHHmmssZ)
	 */
	private static formatGoogleDates(task: TaskInfo, useScheduledAsDue: boolean): string | null {
		const { startICS, endICS } = this.getICSDateFormat(task, useScheduledAsDue);

		if (!startICS) return null;

		// Google expects format: YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ
		if (endICS) {
			return `${startICS}/${endICS}`;
		}

		// For single time, create a 1-hour event
		const start = this.parseICSDate(startICS);
		const end = new Date(start.getTime() + 60 * 60 * 1000); // Add 1 hour
		const endFormatted = this.formatDateToICS(end);

		return `${startICS}/${endFormatted}`;
	}

	/**
	 * Get task date range in ISO format
	 */
	private static getTaskDateRange(
		task: TaskInfo,
		useScheduledAsDue: boolean,
		options?: ICSExportOptions
	): { startISO: string | null; endISO: string | null } {
		let startISO: string | null = null;
		let endISO: string | null = null;

		if (task.scheduled) {
			try {
				const scheduledDate = this.parseTaskDate(task.scheduled);
				startISO = scheduledDate.toISOString();
			} catch (e) {
				console.warn("Invalid scheduled date:", task.scheduled);
			}
		}

		// When useDurationForExport is enabled, use timeEstimate to calculate end time
		// instead of using due date
		if (
			options?.useDurationForExport &&
			startISO &&
			task.timeEstimate &&
			task.timeEstimate > 0
		) {
			// Use scheduled + timeEstimate (in minutes) as end time
			const start = new Date(startISO);
			const end = new Date(start.getTime() + task.timeEstimate * 60 * 1000);
			endISO = end.toISOString();
		} else if (task.due) {
			try {
				const dueDate = this.parseTaskDate(task.due);
				endISO = dueDate.toISOString();
			} catch (e) {
				console.warn("Invalid due date:", task.due);
			}
		} else if (useScheduledAsDue && startISO) {
			// Use scheduled + 1 hour as end time (default fallback)
			const start = new Date(startISO);
			const end = new Date(start.getTime() + 60 * 60 * 1000);
			endISO = end.toISOString();
		}

		return { startISO, endISO };
	}

	/**
	 * Format dates for Yahoo Calendar (YYYYMMDDTHHMMSS)
	 */
	private static getYahooDateFormat(
		task: TaskInfo,
		useScheduledAsDue: boolean
	): { startYahoo: string | null; endYahoo: string | null } {
		const { startISO, endISO } = this.getTaskDateRange(task, useScheduledAsDue);

		const formatYahoo = (isoString: string): string => {
			const date = new Date(isoString);
			return format(date, "yyyyMMdd'T'HHmmss");
		};

		return {
			startYahoo: startISO ? formatYahoo(startISO) : null,
			endYahoo: endISO ? formatYahoo(endISO) : null,
		};
	}

	/**
	 * Format dates for ICS format (YYYYMMDDTHHMMSSZ)
	 */
	private static getICSDateFormat(
		task: TaskInfo,
		useScheduledAsDue = true,
		options?: ICSExportOptions
	): { startICS: string | null; endICS: string | null } {
		const { startISO, endISO } = this.getTaskDateRange(task, useScheduledAsDue, options);

		const formatICS = (isoString: string): string => {
			const date = new Date(isoString);
			return this.formatDateToICS(date);
		};

		return {
			startICS: startISO ? formatICS(startISO) : null,
			endICS: endISO ? formatICS(endISO) : null,
		};
	}

	/**
	 * Build RFC 5545-compliant DTSTART/DTEND lines.
	 * Date-only task dates are exported as all-day events using VALUE=DATE.
	 */
	private static getICSDateProperties(
		task: TaskInfo,
		useScheduledAsDue = true,
		options?: ICSExportOptions
	): ICSDateProperties {
		if (task.scheduled && !this.hasTimeComponent(task.scheduled)) {
			const startDate = task.scheduled;
			const endDateExclusive =
				this.getAllDayEndDate(task, useScheduledAsDue, options) || startDate;

			return {
				startLine: `DTSTART;VALUE=DATE:${this.formatDateOnlyToICS(startDate)}`,
				endLine: `DTEND;VALUE=DATE:${this.formatDateOnlyToICS(endDateExclusive)}`,
			};
		}

		const { startICS, endICS } = this.getICSDateFormat(task, useScheduledAsDue, options);

		return {
			startLine: startICS ? `DTSTART:${startICS}` : null,
			endLine: endICS ? `DTEND:${endICS}` : null,
		};
	}

	/**
	 * Format a Date object to ICS date format
	 */
	private static formatDateToICS(date: Date): string {
		return date
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "");
	}

	/**
	 * Parse ICS date format back to Date object
	 */
	private static parseICSDate(icsDate: string): Date {
		// YYYYMMDDTHHMMSSZ -> YYYY-MM-DDTHH:MM:SSZ
		const year = icsDate.substr(0, 4);
		const month = icsDate.substr(4, 2);
		const day = icsDate.substr(6, 2);
		const hour = icsDate.substr(9, 2);
		const minute = icsDate.substr(11, 2);
		const second = icsDate.substr(13, 2);

		return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
	}

	/**
	 * Parse task date string to Date object
	 */
	private static parseTaskDate(dateStr: string): Date {
		// Handle different date formats
		if (dateStr.includes("T")) {
			// ISO format or local datetime
			return parseISO(dateStr);
		} else {
			// Date only - assume start of day
			return parseISO(`${dateStr}T00:00:00`);
		}
	}

	private static hasTimeComponent(dateStr: string): boolean {
		// Matches both ISO format with T ("2025-08-12T18:00") and space-separated ("2025-08-12 18:00")
		return dateStr.includes("T") || /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dateStr);
	}

	private static formatDateOnlyToICS(dateStr: string): string {
		return dateStr.split("T")[0].replace(/-/g, "");
	}

	private static getAllDayEndDate(
		task: TaskInfo,
		useScheduledAsDue: boolean,
		options?: ICSExportOptions
	): string | null {
		if (!task.scheduled) return null;

		let inclusiveEndDate = task.scheduled;

		if (options?.useDurationForExport && task.timeEstimate && task.timeEstimate > 0) {
			const dayCount = Math.max(1, Math.ceil(task.timeEstimate / (24 * 60)));
			return this.addDaysToDateString(task.scheduled, dayCount);
		}

		if (task.due) {
			inclusiveEndDate = task.due;
		} else if (!useScheduledAsDue) {
			return null;
		}

		return this.addDaysToDateString(inclusiveEndDate, 1);
	}

	private static addDaysToDateString(dateStr: string, days: number): string {
		const baseDate = parseISO(`${dateStr.split("T")[0]}T00:00:00`);
		baseDate.setDate(baseDate.getDate() + days);
		return format(baseDate, "yyyy-MM-dd");
	}

	/**
	 * Escape text for ICS format
	 */
	private static escapeICSText(text: string): string {
		return text
			.replace(/\\/g, "\\\\")
			.replace(/;/g, "\\;")
			.replace(/,/g, "\\,")
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "");
	}

	/**
	 * Fold ICS lines to comply with RFC 5545 (max 75 octets per line)
	 */
	private static foldICSLines(content: string): string {
		const lines = content.split("\r\n");
		const foldedLines: string[] = [];

		lines.forEach((line) => {
			if (line.length <= 75) {
				foldedLines.push(line);
			} else {
				// Fold long lines by breaking at 75 characters and continuing with space
				let remainingLine = line;
				while (remainingLine.length > 75) {
					foldedLines.push(remainingLine.substring(0, 75));
					remainingLine = " " + remainingLine.substring(75); // Continue with space
				}
				if (remainingLine.length > 0) {
					foldedLines.push(remainingLine);
				}
			}
		});

		return foldedLines.join("\r\n");
	}

	/**
	 * Generate VALARM entries for a task reminder
	 * Returns ICS lines for the VALARM, or null if reminder cannot be exported
	 */
	private static generateVALARM(task: TaskInfo, reminder: Reminder): string[] | null {
		let trigger: string;
		let description: string;

		if (reminder.type === "absolute") {
			// Absolute reminders: use the absolute time directly
			// Convert to ICS format: YYYYMMDDTHHMMSSZ
			if (!reminder.absoluteTime) {
				console.warn(
					`TaskNotes ICS Export: Absolute reminder missing absoluteTime, skipping: ${task.title}`
				);
				return null;
			}
			trigger = `VALUE=DATE-TIME:${this.formatDateToICS(new Date(reminder.absoluteTime))}`;
			description = reminder.description || `${task.title} - at scheduled time`;
		} else {
			// Relative reminders: use offset from scheduled or due date
			if (!reminder.offset) {
				console.warn(
					`TaskNotes ICS Export: Relative reminder missing offset, skipping: ${task.title}`
				);
				return null;
			}

			const referenceDate = reminder.relatedTo === "due" ? task.due : task.scheduled;

			if (!referenceDate) {
				return null;
			}

			// Use the reminder's offset directly (e.g., -PT15M)
			trigger = reminder.offset;

			// Generate description based on offset direction
			const offsetMinutes = this.parseISO8601Duration(reminder.offset);
			const direction = offsetMinutes < 0 ? "before" : "after";
			const absMinutes = Math.abs(offsetMinutes);

			let timeDesc: string;
			if (absMinutes >= 60) {
				const hours = Math.floor(absMinutes / 60);
				timeDesc = hours === 1 ? "1 hour" : `${hours} hours`;
			} else {
				timeDesc = absMinutes === 1 ? "1 minute" : `${absMinutes} minutes`;
			}

			description = reminder.description || `${task.title} - ${timeDesc} ${direction}`;
		}

		return [
			"BEGIN:VALARM",
			`TRIGGER:${trigger}`,
			"ACTION:DISPLAY",
			`DESCRIPTION:${this.escapeICSText(description)}`,
			"END:VALARM",
		];
	}

	/**
	 * Parse ISO 8601 duration to minutes
	 * Supports PT15M, PT1H, PT30M, -PT15M, -PT1H, etc.
	 */
	private static parseISO8601Duration(duration: string): number {
		const match = duration.match(/^(-?)PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
		if (!match) {
			return 0;
		}

		const negative = match[1] === "-";
		const hours = parseInt(match[2] || "0", 10);
		const minutes = parseInt(match[3] || "0", 10);
		const seconds = parseInt(match[4] || "0", 10);

		const totalMinutes = hours * 60 + minutes + seconds / 60;
		return negative ? -totalMinutes : totalMinutes;
	}

	/**
	 * Generate ICS content for multiple tasks
	 */
	static generateMultipleTasksICSContent(tasks: TaskInfo[], options?: ICSExportOptions): string {
		if (options?.exportFormat === "vtodo") {
			return this.generateMultipleTasksVTODOContent(tasks, options);
		}

		const filteredTasks = this.filterTasksForExport(tasks, options);

		const now = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "");

		const lines = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//TaskNotes//EN",
			"CALSCALE:GREGORIAN",
		];

		// Add VTIMEZONE block when timezone is provided (Nextcloud/CalDAV)
		if (options?.timezone) {
			const tzLines = this.generateVTIMEZONE(options.timezone);
			lines.push(...tzLines);
		}

		// Add each task as a VEVENT
		filteredTasks.forEach((task, index) => {
			const uid = `${task.path.replace(/[^a-zA-Z0-9]/g, "-")}-${index}-${Date.now()}@tasknotes`;

			lines.push("BEGIN:VEVENT");
			lines.push(`UID:${uid}`);
			lines.push(`DTSTAMP:${now}`);

			// Add title
			lines.push(`SUMMARY:${this.escapeICSText(task.title)}`);

			// Add dates - ensure every event has a DTSTART (required by ICS standard)
			// Skip when recurrence is enabled (recurrence code block below handles DTSTART/DTEND)
			const useRecurrenceDates = options?.includeRecurrence && task.recurrence;

			if (!useRecurrenceDates) {
				let { startLine, endLine } = this.getICSDateProperties(task, true, options);

				// If no start date, use task creation date or current date as fallback
				if (!startLine) {
					// Try to use task.scheduled for local time
					if (options?.timezone && task.scheduled && task.scheduled.includes("T")) {
						// Use local time directly - no UTC conversion
						const startTime = this.formatLocalTime(task.scheduled);
						const endTime = this.formatLocalEndTime(
							task.scheduled,
							task.timeEstimate || 60
						);
						startLine = `DTSTART;TZID=${options.timezone}:${startTime}`;
						endLine = `DTEND;TZID=${options.timezone}:${endTime}`;
					} else {
						// Fallback to task creation date or current date in UTC
						let fallbackDate: Date;
						if (task.dateCreated) {
							fallbackDate = new Date(task.dateCreated);
						} else {
							fallbackDate = new Date();
						}
						const startICS = this.formatDateToICS(fallbackDate);
						startLine = `DTSTART:${startICS}`;

						// Set end time to 1 hour after start for tasks without duration
						if (!endLine) {
							const endDate = new Date(fallbackDate.getTime() + 60 * 60 * 1000); // +1 hour
							const endICS = this.formatDateToICS(endDate);
							endLine = `DTEND:${endICS}`;
						}
					}
				} else if (!endLine) {
					const startValue = startLine.split(":", 2)[1];
					if (startLine.includes("VALUE=DATE")) {
						const startDate = parseISO(
							`${startValue.slice(0, 4)}-${startValue.slice(4, 6)}-${startValue.slice(6, 8)}T00:00:00`
						);
						startDate.setDate(startDate.getDate() + 1);
						endLine = `DTEND;VALUE=DATE:${format(startDate, "yyyyMMdd")}`;
					} else {
						// If we have start but no end, add 1 hour duration
						const startDate = this.parseICSDate(startValue);
						const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1 hour
						const endICS = this.formatDateToICS(endDate);
						const endDTEND = options?.timezone
							? `DTEND;TZID=${options.timezone}:${endICS.replace("Z", "")}`
							: `DTEND:${endICS}`;
						endLine = endDTEND;
					}
				}

				lines.push(startLine);
				lines.push(endLine);
			}

			// Add description
			const description = this.buildDescription(task, options);
			if (description) {
				lines.push(`DESCRIPTION:${this.escapeICSText(description)}`);
			}

			// Add categories from tags and contexts (contexts prefixed with @)
			const categories = [
				...(task.tags ?? []).map((t) => this.escapeICSText(t)),
				...(task.contexts ?? []).map((c) => this.escapeICSText(`@${c}`)),
			];
			if (categories.length > 0) {
				lines.push(`CATEGORIES:${categories.join(",")}`);
			}

			// Map priority (ICS uses 1-9, with 1 being highest)
			if (task.priority) {
				const priorityMap: Record<string, string> = {
					highest: "1",
					high: "3",
					medium: "5",
					low: "7",
					lowest: "9",
				};
				const icsPriority = priorityMap[task.priority] || "5";
				lines.push(`PRIORITY:${icsPriority}`);
			}

			// Map status — VEVENT uses TENTATIVE/CONFIRMED/CANCELLED
			if (task.status) {
				lines.push(`STATUS:${this.getVEventStatus(task.status)}`);
			}

			// Add RRULE for recurring tasks when enabled
			if (options?.includeRecurrence && task.recurrence) {
				const rruleWithDTSTART = addDTSTARTToRecurrenceRule(task);
				if (rruleWithDTSTART) {
					// NEW LOGIC: Use task.scheduled instead of recurrence's DTSTART for current occurrence
					let startDate: Date | null = null;
					let isDateOnly = false;

					const scheduledHasTime = task.scheduled && task.scheduled.includes("T");

					if (scheduledHasTime) {
						// Scheduled has time component - use it
						// parseTaskDate returns local time, formatDateToICS converts to UTC (per RFC 5545)
						startDate = this.parseTaskDate(task.scheduled!);
						isDateOnly = false;
					} else if (task.scheduled) {
						// Scheduled is date-only - check if recurrence has time
						const dtstartMatch = task.recurrence?.match(/DTSTART:(\d{8}(?:T\d{6}Z?)?)/);
						const recurrenceHasTime = dtstartMatch && dtstartMatch[1].length > 8;

						if (recurrenceHasTime && dtstartMatch) {
							// Recurrence has time - use it for this occurrence
							// Strip Z to treat as local time, then convert to UTC for ICS
							startDate = this.parseICSDate(dtstartMatch[1].replace("Z", ""));
							isDateOnly = false;
						} else {
							// Both are date-only - all-day event
							startDate = this.parseTaskDate(task.scheduled);
							isDateOnly = true;
						}
					} else {
						// No scheduled - fall back to recurrence's original DTSTART (legacy behavior)
						const dtstartMatch = rruleWithDTSTART.match(/^DTSTART:([^;]+)/);
						const originalDTSTART = dtstartMatch ? dtstartMatch[1] : null;
						if (originalDTSTART) {
							isDateOnly = originalDTSTART.length === 8;
							if (isDateOnly) {
								const year = parseInt(originalDTSTART.slice(0, 4));
								const month = parseInt(originalDTSTART.slice(4, 6)) - 1;
								const day = parseInt(originalDTSTART.slice(6, 8));
								startDate = new Date(year, month, day);
							} else {
								startDate = this.parseICSDate(originalDTSTART);
							}
						}
					}

					if (startDate) {
						// Calculate DTEND based on existing logic (respects useDurationForExport)
						let endDate: Date;
						if (
							options?.useDurationForExport &&
							task.timeEstimate &&
							task.timeEstimate > 0
						) {
							endDate = new Date(startDate.getTime() + task.timeEstimate * 60 * 1000);
						} else if (!isDateOnly) {
							endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
						} else {
							endDate = new Date(startDate);
							endDate.setDate(endDate.getDate() + 1);
						}

						// Format DTSTART for ICS
						if (isDateOnly) {
							const year = startDate.getFullYear();
							const month = String(startDate.getMonth() + 1).padStart(2, "0");
							const day = String(startDate.getDate()).padStart(2, "0");
							const dateStr = `${year}${month}${day}`;
							const endYear = endDate.getFullYear();
							const endMonth = String(endDate.getMonth() + 1).padStart(2, "0");
							const endDay = String(endDate.getDate()).padStart(2, "0");
							const endDateStr = `${endYear}${endMonth}${endDay}`;
							lines.push(`DTSTART;VALUE=DATE:${dateStr}`);
							lines.push(`DTEND;VALUE=DATE:${endDateStr}`);
						} else {
							// Use local time from task.scheduled without UTC conversion
							let startTimeVal: string;
							let endTimeVal: string;

							if (
								options?.timezone &&
								task.scheduled &&
								task.scheduled.includes("T")
							) {
								// Use local time directly for timezone-aware export
								startTimeVal = this.formatLocalTime(task.scheduled);
								endTimeVal = this.formatLocalEndTime(
									task.scheduled,
									task.timeEstimate || 60
								);
							} else {
								// Fallback to UTC (for ICS export or when no scheduled time)
								startTimeVal = this.formatDateToICS(startDate);
								endTimeVal = this.formatDateToICS(endDate);
							}

							const dtstart = options?.timezone
								? `DTSTART;TZID=${options.timezone}:${startTimeVal}`
								: `DTSTART:${startTimeVal}`;
							const dtend = options?.timezone
								? `DTEND;TZID=${options.timezone}:${endTimeVal}`
								: `DTEND:${endTimeVal}`;
							lines.push(dtstart);
							lines.push(dtend);
						}
					}

					// Strip embedded DTSTART from RRULE (keep only the rule - valid RFC 5545)
					const rruleLine = rruleWithDTSTART.replace(/^DTSTART:[^;]+;?/, "");
					lines.push(`RRULE:${rruleLine}`);
				}
			}

			// Add VALARMs for task reminders when enabled
			if (options?.includeReminders && task.reminders && task.reminders.length > 0) {
				for (const reminder of task.reminders) {
					const valarmLines = this.generateVALARM(task, reminder);
					if (valarmLines) {
						lines.push(...valarmLines);
					}
				}
			}

			lines.push("END:VEVENT");
		});

		lines.push("END:VCALENDAR");

		// Join lines and ensure proper ICS line folding (max 75 chars per line)
		return this.foldICSLines(lines.join("\r\n"));
	}

	/**
	 * Generate ICS content with VTODO components for multiple tasks
	 */
	static generateMultipleTasksVTODOContent(
		tasks: TaskInfo[],
		options?: ICSExportOptions
	): string {
		const now = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "");

		const lines = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"PRODID:-//TaskNotes//Task Export//EN",
			"CALSCALE:GREGORIAN",
		];

		tasks.forEach((task, index) => {
			const todoLines = this.generateSingleTaskVTODO(task, index, now, options);
			lines.push(...todoLines);
		});

		lines.push("END:VCALENDAR");

		return this.foldICSLines(lines.join("\r\n"));
	}

	/**
	 * Generate a single VTODO component for a task
	 */
	private static generateSingleTaskVTODO(
		task: TaskInfo,
		index: number,
		now: string,
		options?: ICSExportOptions
	): string[] {
		const uid = `${task.path.replace(/[^a-zA-Z0-9]/g, "-")}-${index}-${Date.now()}@tasknotes`;
		const lines: string[] = [];

		lines.push("BEGIN:VTODO");
		lines.push(`UID:${uid}`);
		lines.push(`DTSTAMP:${now}`);

		// SUMMARY (required)
		lines.push(`SUMMARY:${this.escapeICSText(task.title)}`);

		// DTSTART and DUE - RFC 5545 requires:
		// 1. Both must use the same value type (DATE or DATE-TIME)
		// 2. DUE must occur after DTSTART
		const hasDue = !!task.due;
		const hasScheduled = !!task.scheduled;
		const dueHasTime = hasDue && this.hasTimeComponent(task.due!);
		const scheduledHasTime = hasScheduled && this.hasTimeComponent(task.scheduled!);

		if (hasDue && hasScheduled) {
			// Both exist: use consistent type (date-only if both are date-only, datetime otherwise)
			const useDateTime = dueHasTime || scheduledHasTime;
			const scheduledDate = this.parseTaskDate(task.scheduled!);
			const dueDate = this.parseTaskDate(task.due!);

			// Only emit both if DUE is after DTSTART
			if (dueDate.getTime() > scheduledDate.getTime()) {
				if (useDateTime) {
					lines.push(`DTSTART:${this.formatDateToICS(scheduledDate)}`);
					lines.push(`DUE:${this.formatDateToICS(dueDate)}`);
				} else {
					lines.push(`DTSTART;VALUE=DATE:${this.formatDateOnlyToICS(task.scheduled!)}`);
					lines.push(`DUE;VALUE=DATE:${this.formatDateOnlyToICS(task.due!)}`);
				}
			} else {
				// DUE is not after DTSTART — only emit DUE (skip DTSTART to avoid validation error)
				if (dueHasTime) {
					lines.push(`DUE:${this.formatDateToICS(dueDate)}`);
				} else {
					lines.push(`DUE;VALUE=DATE:${this.formatDateOnlyToICS(task.due!)}`);
				}
			}
		} else if (hasDue) {
			if (dueHasTime) {
				lines.push(`DUE:${this.formatDateToICS(this.parseTaskDate(task.due!))}`);
			} else {
				lines.push(`DUE;VALUE=DATE:${this.formatDateOnlyToICS(task.due!)}`);
			}
		} else if (hasScheduled) {
			if (scheduledHasTime) {
				lines.push(`DTSTART:${this.formatDateToICS(this.parseTaskDate(task.scheduled!))}`);
			} else {
				lines.push(`DTSTART;VALUE=DATE:${this.formatDateOnlyToICS(task.scheduled!)}`);
			}
		}

		// STATUS - VTODO uses NEEDS-ACTION, IN-PROCESS, COMPLETED, CANCELLED
		if (task.status) {
			const statusMap: Record<string, string> = {
				done: "COMPLETED",
				"in-progress": "IN-PROCESS",
				todo: "NEEDS-ACTION",
				cancelled: "CANCELLED",
			};
			lines.push(`STATUS:${statusMap[task.status] || "NEEDS-ACTION"}`);
		}

		// COMPLETED timestamp when done
		if (task.status === "done" && task.completedDate) {
			const completed = this.parseTaskDate(task.completedDate);
			lines.push(`COMPLETED:${this.formatDateToICS(completed)}`);
		}

		// PERCENT-COMPLETE
		if (task.status === "done") {
			lines.push("PERCENT-COMPLETE:100");
		} else if (task.status === "in-progress") {
			lines.push("PERCENT-COMPLETE:50");
		}

		// PRIORITY (1 = highest, 9 = lowest, 0 = undefined)
		if (task.priority) {
			const priorityMap: Record<string, string> = {
				highest: "1",
				high: "3",
				medium: "5",
				low: "7",
				lowest: "9",
			};
			lines.push(`PRIORITY:${priorityMap[task.priority] || "0"}`);
		}

		// CATEGORIES from tags and contexts (contexts prefixed with @)
		const vtodoCategories = [
			...(task.tags ?? []).map((t) => this.escapeICSText(t)),
			...(task.contexts ?? []).map((c) => this.escapeICSText(`@${c}`)),
		];
		if (vtodoCategories.length > 0) {
			lines.push(`CATEGORIES:${vtodoCategories.join(",")}`);
		}

		// ESTIMATED-DURATION from timeEstimate
		if (task.timeEstimate && task.timeEstimate > 0) {
			const hours = Math.floor(task.timeEstimate / 60);
			const minutes = task.timeEstimate % 60;
			let duration = "PT";
			if (hours > 0) duration += `${hours}H`;
			if (minutes > 0) duration += `${minutes}M`;
			if (hours === 0 && minutes === 0) duration += "0M";
			lines.push(`ESTIMATED-DURATION:${duration}`);
		}

		// RRULE for recurring tasks
		if (options?.includeRecurrence && task.recurrence) {
			const rruleWithDTSTART = addDTSTARTToRecurrenceRule(task);
			if (rruleWithDTSTART) {
				const rruleLine = rruleWithDTSTART.replace(/^DTSTART:[^;]+;?/, "");
				lines.push(`RRULE:${rruleLine}`);
			}
		}

		// DESCRIPTION
		const description = this.buildDescription(task);
		if (description) {
			lines.push(`DESCRIPTION:${this.escapeICSText(description)}`);
		}

		// VALARMs for reminders
		if (options?.includeReminders && task.reminders && task.reminders.length > 0) {
			for (const reminder of task.reminders) {
				const valarmLines = this.generateVALARM(task, reminder);
				if (valarmLines) {
					lines.push(...valarmLines);
				}
			}
		}

		lines.push("END:VTODO");

		return lines;
	}

	/**
	 * Download ICS file for all tasks
	 */
	static downloadAllTasksICSFile(
		tasks: TaskInfo[],
		translate?: TranslateFn,
		options?: ICSExportOptions
	): void {
		try {
			if (!tasks || tasks.length === 0) {
				new Notice(
					translate
						? translate("services.calendarExport.notices.noTasksToExport")
						: "No tasks found to export"
				);
				return;
			}

			const icsContent = this.generateMultipleTasksICSContent(tasks, options);
			const blob = new Blob([icsContent], { type: "text/calendar" });
			const url = URL.createObjectURL(blob);

			const date = new Date().toISOString().split("T")[0];
			const filename = `tasknotes-all-tasks-${date}.ics`;

			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();

			URL.revokeObjectURL(url);

			const pluralSuffix = tasks.length === 1 ? "" : "s";
			new Notice(
				translate
					? translate("services.calendarExport.notices.downloadSuccess", {
							filename,
							count: tasks.length,
							plural: pluralSuffix,
						})
					: `Downloaded ${filename} with ${tasks.length} task${pluralSuffix}`
			);
		} catch (error) {
			console.error("Failed to download all tasks ICS file:", error);
			new Notice(
				translate
					? translate("services.calendarExport.notices.downloadFailed")
					: "Failed to download calendar file"
			);
		}
	}

	/**
	 * Download ICS file for a task
	 */
	static downloadICSFile(
		task: TaskInfo,
		translate?: TranslateFn,
		options?: ICSExportOptions
	): void {
		try {
			const icsContent = this.generateICSContent(task, options);
			const blob = new Blob([icsContent], { type: "text/calendar" });
			const url = URL.createObjectURL(blob);

			const filename = `${task.title.replace(/[^a-zA-Z0-9]/g, "-")}.ics`;

			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			a.click();

			URL.revokeObjectURL(url);

			new Notice(
				translate
					? translate("services.calendarExport.notices.singleDownloadSuccess", {
							filename,
						})
					: `Downloaded ${filename}`
			);
		} catch (error) {
			console.error("Failed to download ICS file:", error);
			new Notice(
				translate
					? translate("services.calendarExport.notices.downloadFailed")
					: "Failed to download calendar file"
			);
		}
	}

	/**
	 * Generate VTIMEZONE block for a given IANA timezone
	 * Simplified version that works with most common timezones
	 */
	private static generateVTIMEZONE(tzid: string): string[] {
		const lines = [
			`BEGIN:VTIMEZONE`,
			`TZID:${tzid}`,
			`BEGIN:DAYLIGHT`,
			`TZNAME:EDT`,
			`TZOFFSETFROM:-0500`,
			`TZOFFSETTO:-0400`,
			`DTSTART:19700308T020000`,
			`RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU`,
			`END:DAYLIGHT`,
			`BEGIN:STANDARD`,
			`TZNAME:EST`,
			`TZOFFSETFROM:-0400`,
			`TZOFFSETTO:-0500`,
			`DTSTART:19701101T020000`,
			`RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU`,
			`END:STANDARD`,
			`END:VTIMEZONE`,
		];
		return lines;
	}

	/**
	 * Format local time from task.scheduled WITHOUT UTC conversion
	 * Used for CalDAV export with TZID
	 * Input: "2026-04-07T07:00" or "2026-04-07T07:00:00" → "20260407T070000"
	 */
	private static formatLocalTime(localDateStr: string): string {
		if (!localDateStr || !localDateStr.includes("T")) {
			return "";
		}
		const [datePart, timePart] = localDateStr.split("T");
		const timeParts = timePart.split(":");
		const hours = timeParts[0];
		const minutes = timeParts[1];
		const seconds = timeParts[2] ?? "00";

		if (!hours || !minutes) {
			console.warn("Invalid time format in scheduled date:", localDateStr);
			return "";
		}

		return `${datePart.replace(/-/g, "")}T${hours.padStart(2, "0")}${minutes.padStart(2, "0")}${seconds.padStart(2, "0")}`;
	}

	/**
	 * Format duration from timeEstimate for local time
	 * Input: scheduled "2026-04-07T07:00", duration 60 minutes → "20260407T080000"
	 */
	private static formatLocalEndTime(localDateStr: string, durationMinutes: number): string {
		if (!localDateStr || !localDateStr.includes("T")) {
			return "";
		}
		const [datePart, timePart] = localDateStr.split("T");
		const timeParts = timePart.split(":");
		const hours = timeParts[0];
		const minutes = timeParts[1];
		const seconds = timeParts[2] ?? "00";

		if (!hours || !minutes) {
			console.warn("Invalid time format in scheduled date:", localDateStr);
			return "";
		}

		const totalMinutes = parseInt(hours) * 60 + parseInt(minutes) + (durationMinutes || 60);
		const endHours = Math.floor(totalMinutes / 60) % 24;
		const endMinutes = totalMinutes % 60;
		return `${datePart.replace(/-/g, "")}T${String(endHours).padStart(2, "0")}${String(endMinutes).padStart(2, "0")}${seconds}`;
	}

	private static getVEventStatus(status: string): VEventStatus {
		const normalizedStatus = status.trim().toLowerCase();
		if (normalizedStatus === "cancelled" || normalizedStatus === "canceled") {
			return "CANCELLED";
		}
		if (normalizedStatus === "tentative") {
			return "TENTATIVE";
		}
		return "CONFIRMED";
	}

	private static filterTasksForExport(tasks: TaskInfo[], options?: ICSExportOptions): TaskInfo[] {
		if (
			!options?.excludeArchived &&
			!options?.excludeCompleted &&
			!options?.requireDueDate &&
			!options?.requireScheduledDate
		) {
			return tasks;
		}

		const completedStatuses = new Set(
			options.completedStatuses?.length ? options.completedStatuses : ["done"]
		);
		return tasks.filter((task) => {
			if (options.excludeArchived && task.archived) {
				return false;
			}
			if (options.excludeCompleted && completedStatuses.has(task.status)) {
				return false;
			}
			if (options.requireDueDate && !task.due) {
				return false;
			}
			if (options.requireScheduledDate && !task.scheduled) {
				return false;
			}
			return true;
		});
	}

	static createMultipleTasksICSDownload(
		tasks: TaskInfo[],
		options?: ICSExportOptions
	): ICSDownloadFile | null {
		if (!tasks || tasks.length === 0) {
			return null;
		}

		const exportTasks = this.filterTasksForExport(tasks, options);
		if (exportTasks.length === 0) {
			return null;
		}

		const date = new Date().toISOString().split("T")[0];
		return {
			content: this.generateMultipleTasksICSContent(exportTasks, options),
			filename: `tasknotes-all-tasks-${date}.ics`,
			taskCount: exportTasks.length,
		};
	}

	static createTaskICSDownload(task: TaskInfo, options?: ICSExportOptions): ICSDownloadFile {
		return {
			content: this.generateICSContent(task, options),
			filename: `${task.title.replace(/[^a-zA-Z0-9]/g, "-")}.ics`,
			taskCount: 1,
		};
	}
}