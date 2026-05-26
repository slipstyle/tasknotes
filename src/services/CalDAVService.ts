import type TaskNotesPlugin from "../main";
import { requestUrl, TFile } from "obsidian";
import { TaskInfo } from "../types";
import { CalendarExportService } from "./CalendarExportService";

export interface CalDAVCredentials {
	url: string;
	username: string;
	password: string;
}

export interface CalDAVPushOptions {
	includeReminders: boolean;
	includeRecurrence: boolean;
	useDurationForExport: boolean;
	concurrentExports: number;
}

export interface CalDAVPushResult {
	success: boolean;
	eventsPushed: number;
	eventsDeleted: number;
	errors: string[];
}

const CALDAV_DATA_KEY = "caldavCredentials";

export class CalDAVService {
	private plugin: TaskNotesPlugin;

	constructor(plugin: TaskNotesPlugin) {
		this.plugin = plugin;
	}

	private isDebugEnabled(): boolean {
		return this.plugin.settings.caldavExport?.enableDebugLogging ?? false;
	}

	private logDebug(...args: unknown[]): void {
		if (this.isDebugEnabled()) {
			console.log(...args);
		}
	}

	async saveCredentials(url: string, username: string, password: string): Promise<void> {
		const data = (await this.plugin.loadData()) || {};
		data[CALDAV_DATA_KEY] = { url, username, password };
		await this.plugin.saveData(data);
	}

	async loadCredentials(): Promise<CalDAVCredentials | null> {
		const data = await this.plugin.loadData();
		return data?.[CALDAV_DATA_KEY] as CalDAVCredentials | null;
	}

	async clearCredentials(): Promise<void> {
		const data = (await this.plugin.loadData()) || {};
		delete data[CALDAV_DATA_KEY];
		await this.plugin.saveData(data);
	}

	async testConnection(
		url: string,
		username: string,
		password: string
	): Promise<{ success: boolean; error?: string }> {
		console.log("[CalDAV] testConnection called with URL:", url);
		try {
			const authHeader = "Basic " + btoa(`${username}:${password}`);
			const response = await requestUrl({
				url: url,
				method: "PROPFIND",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/xml; charset=utf-8",
					Depth: "0",
				},
				body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
				throw: false,
			});

			if (response.status === 401) {
				return { success: false, error: "Invalid credentials" };
			}

			if (response.status === 404) {
				return { success: false, error: "Calendar not found" };
			}

			if (response.status >= 200 && response.status < 300) {
				return { success: true };
			}

			return { success: false, error: `HTTP ${response.status}` };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			console.error("[CalDAV] Connection test failed with error:", err);
			const message = err.message || "Unknown error";
			if (message.includes("ENOTFOUND")) {
				return { success: false, error: "Invalid URL or network error" };
			}
			return { success: false, error: message };
		}
	}

	async pushEvents(tasks: TaskInfo[], options: CalDAVPushOptions): Promise<CalDAVPushResult> {
		const credentials = await this.loadCredentials();
		if (!credentials) {
			return {
				success: false,
				eventsPushed: 0,
				eventsDeleted: 0,
				errors: ["No credentials configured"],
			};
		}

		const { url, username, password } = credentials;
		const authHeader = "Basic " + btoa(`${username}:${password}`);

		// Step 1: Get existing CalDAV events with their UIDs
		console.log("[CalDAV] Fetching existing events from calendar...");
		const existingEvents = await this.getExistingEventsWithUIDs(url, authHeader);
		console.log(`[CalDAV] Found ${existingEvents.length} existing events`);

		// Step 1.5: Re-fetch each task fresh from cache to get latest frontmatter (like Google Calendar)
		this.logDebug("[CalDAV] Refreshing task data from cache...");
		const freshTasks: TaskInfo[] = [];
		for (const task of tasks) {
			const freshTask = await this.plugin.cacheManager.getTaskInfo(task.path);
			if (freshTask) {
				freshTasks.push(freshTask);
			} else {
				freshTasks.push(task);
			}
		}
		tasks = freshTasks;
		this.logDebug(`[CalDAV] Refreshed ${tasks.length} tasks from cache`);

		// Step 2: Build sets for diff calculation using caldavEventId (UUID)
		const taskIds = new Set<string>(); // caldavEventId -> Task
		const taskIdMap = new Map<string, TaskInfo>();

		for (const task of tasks) {
			if (task.caldavEventId) {
				taskIds.add(task.caldavEventId);
				taskIdMap.set(task.caldavEventId, task);
			}
		}

		// DEBUG: Log task IDs from frontmatter
		const taskIdArray = Array.from(taskIds);
		this.logDebug(
			`[CalDAV] Task IDs from frontmatter: ${taskIdArray.slice(0, 5).join(", ")}... (${taskIdArray.length} total)`
		);

		const caldavIds = new Set<string>();
		const caldavIdToHref = new Map<string, string>(); // caldavEventId -> href (for deletion)

		for (const event of existingEvents) {
			if (event.uid) {
				caldavIds.add(event.uid);
				caldavIdToHref.set(event.uid, event.href);
			}
		}

		// DEBUG: Log CalDAV UIDs from PROPFIND
		const caldavIdArray = Array.from(caldavIds);
		this.logDebug(
			`[CalDAV] CalDAV UIDs from PROPFIND: ${caldavIdArray.slice(0, 5).join(", ")}... (${caldavIdArray.length} total)`
		);

		// Step 3: Calculate diffs using UUID matching
		const toCreate: TaskInfo[] = []; // In TaskNotes, not in CalDAV
		const toUpdate: TaskInfo[] = []; // In both, needs update
		const toDelete: string[] = []; // In CalDAV, not in TaskNotes

		for (const task of tasks) {
			if (task.caldavEventId && caldavIds.has(task.caldavEventId)) {
				// Exists in both - needs update
				toUpdate.push(task);
			} else {
				// New task or task without stored ID
				toCreate.push(task);
			}
		}

		// DEBUG: Show orphan calculation
		let orphanCount = 0;
		for (const caldavId of caldavIds) {
			if (!taskIds.has(caldavId)) {
				orphanCount++;
			}
		}
		this.logDebug(
			`[CalDAV] Orphan check: CalDAV has ${caldavIds.size} UIDs, TaskNotes has ${taskIds.size} IDs, should delete ~${orphanCount}`
		);

		for (const caldavId of caldavIds) {
			if (!taskIds.has(caldavId)) {
				// Exists in CalDAV but not in TaskNotes - orphan to delete
				const href = caldavIdToHref.get(caldavId);
				if (href) {
					toDelete.push(href);
				}
			}
		}

		console.log(
			`[CalDAV] Sync diff - Create: ${toCreate.length}, Update: ${toUpdate.length}, Delete: ${toDelete.length}`
		);

		const errors: string[] = [];
		let eventsPushed = 0;
		let eventsDeleted = 0;
		const concurrentExports = options.concurrentExports || 5;

		// Step 4: Delete orphaned events (parallel)
		if (toDelete.length > 0) {
			console.log(`[CalDAV] Deleting ${toDelete.length} orphaned events...`);
			let deleteErrors = 0;
			for (let i = 0; i < toDelete.length; i += concurrentExports) {
				const batch = toDelete.slice(i, i + concurrentExports);
				const results = await Promise.all(
					batch.map(async (href) => {
						try {
							await this.deleteEvent(url, authHeader, href);
							return { success: true, href };
						} catch (error) {
							const errorStr = error instanceof Error ? error.message : String(error);
							// Check if it's a trashbin conflict - the event is effectively already deleted
							if (
								errorStr.includes("already exists") &&
								errorStr.includes("trashbin")
							) {
								console.log(
									`[CalDAV] Event already in trashbin (effectively deleted): ${href}`
								);
								return { success: true, href };
							}
							console.error(`[CalDAV] Failed to delete event ${href}:`, error);
							deleteErrors++;
							return { success: false, href };
						}
					})
				);
				eventsDeleted += results.filter((r) => r.success).length;
			}
			if (deleteErrors > 0) {
				console.log(
					`[CalDAV] Note: ${deleteErrors} events could not be deleted (trashbin conflicts). They will be re-attempted on next export.`
				);
			}
		}

		// Step 5: Create new events (parallel)
		if (toCreate.length > 0) {
			console.log(`[CalDAV] Creating ${toCreate.length} new events...`);
			for (let i = 0; i < toCreate.length; i += concurrentExports) {
				const batch = toCreate.slice(i, i + concurrentExports);
				const results = await Promise.all(
					batch.map(async (task) => {
						try {
							const result = await this.pushSingleTask(
								task,
								options,
								url,
								authHeader
							);
							return {
								success: true,
								task,
								eventId: result.id,
								eventUrl: result.url,
							};
						} catch (error) {
							const err = error instanceof Error ? error : error;
							console.error(`[CalDAV] Failed to create task "${task.title}":`, err);
							return { success: false, task, error: (err as Error).message };
						}
					})
				);

				for (const result of results) {
					if (result.success && result.eventId) {
						eventsPushed++;
						// Store the event ID and URL in task for future syncs
						await this.saveTaskEventId(result.task.path, result.eventId);
						await this.saveTaskEventUrl(result.task.path, result.eventUrl);
						// Also update in-memory task object for subsequent exports in same session
						result.task.caldavEventId = result.eventId;
						result.task.caldavEventUrl = result.eventUrl;
					} else if (result.error) {
						errors.push(`Task "${result.task.title}": ${result.error}`);
					}
				}
			}
		}

		// Step 6: Update existing events (parallel)
		if (toUpdate.length > 0) {
			console.log(`[CalDAV] Updating ${toUpdate.length} existing events...`);
			for (let i = 0; i < toUpdate.length; i += concurrentExports) {
				const batch = toUpdate.slice(i, i + concurrentExports);
				const results = await Promise.all(
					batch.map(async (task) => {
						try {
							await this.pushSingleTask(task, options, url, authHeader);
							return { success: true, task };
						} catch (error) {
							const err = error instanceof Error ? error : error;
							console.error(`[CalDAV] Failed to update task "${task.title}":`, err);
							return { success: false, task, error: (err as Error).message };
						}
					})
				);

				for (const result of results) {
					if (result.success) {
						eventsPushed++;
						// Update last synced time
						await this.saveTaskLastSynced(result.task.path);
					} else if (result.error) {
						errors.push(`Task "${result.task.title}": ${result.error}`);
					}
				}
			}
		}

		console.log(
			`[CalDAV] Sync complete - Created: ${toCreate.length}, Updated: ${toUpdate.length}, Deleted: ${toDelete.length}`
		);

		return {
			success: errors.length === 0,
			eventsPushed,
			eventsDeleted,
			errors,
		};
	}

	/**
	 * Save the CalDAV event URL to the task's frontmatter
	 */
	private async saveTaskEventUrl(taskPath: string, eventUrl: string): Promise<void> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(taskPath);
			if (!file || !(file instanceof TFile)) {
				console.warn(`[CalDAV] Could not find task file: ${taskPath}`);
				return;
			}

			const fieldName = this.plugin.fieldMapper.toUserField("caldavEventUrl");
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[fieldName] = eventUrl;
			});

			this.logDebug(`[CalDAV] Saved event URL for: ${taskPath}`);
		} catch (error) {
			console.error(`[CalDAV] Failed to save event URL for ${taskPath}:`, error);
		}
	}

	/**
	 * Save the CalDAV event ID (UUID) to the task's frontmatter
	 */
	private async saveTaskEventId(taskPath: string, eventId: string): Promise<void> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(taskPath);
			if (!file || !(file instanceof TFile)) {
				console.warn(`[CalDAV] Could not find task file: ${taskPath}`);
				return;
			}

			const fieldName = this.plugin.fieldMapper.toUserField("caldavEventId");
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[fieldName] = eventId;
			});

			this.logDebug(`[CalDAV] Saved event ID for: ${taskPath}`);
		} catch (error) {
			console.error(`[CalDAV] Failed to save event ID for ${taskPath}:`, error);
		}
	}

	/**
	 * Save last synced timestamp to task's frontmatter
	 */
	private async saveTaskLastSynced(taskPath: string): Promise<void> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(taskPath);
			if (!file || !(file instanceof TFile)) {
				return;
			}

			const fieldName = this.plugin.fieldMapper.toUserField("caldavLastSynced");
			const now = new Date().toISOString();
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter[fieldName] = now;
			});
		} catch (error) {
			console.error(`[CalDAV] Failed to save last synced for ${taskPath}:`, error);
		}
	}

	private async deleteCalendar(baseUrl: string, authHeader: string): Promise<void> {
		const response = await requestUrl({
			url: baseUrl,
			method: "DELETE",
			headers: { Authorization: authHeader },
			throw: false,
		});

		// 204 = deleted, 404 = doesn't exist (both are fine)
		if (response.status >= 400 && response.status !== 404) {
			throw new Error(`Failed to delete calendar: HTTP ${response.status}`);
		}
		console.log("[CalDAV] Calendar deleted");
	}

	private async createCalendar(baseUrl: string, authHeader: string): Promise<void> {
		const response = await requestUrl({
			url: baseUrl,
			method: "MKCOL",
			headers: { Authorization: authHeader },
			throw: false,
		});

		// 201 = created, 405 = already exists (both are fine)
		if (response.status >= 400 && response.status !== 405) {
			throw new Error(`Failed to create calendar: HTTP ${response.status}`);
		}
		console.log("[CalDAV] Calendar created");
	}

	private async getExistingEvents(baseUrl: string, authHeader: string): Promise<string[]> {
		const response = await requestUrl({
			url: baseUrl,
			method: "PROPFIND",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/xml; charset=utf-8",
				Depth: "1",
			},
			body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:href/></D:prop></D:propfind>',
			throw: false,
		});

		if (response.status >= 400) {
			console.warn(
				`[CalDAV] PROPFIND failed with HTTP ${response.status}, assuming empty calendar`
			);
			return [];
		}

		const text = response.text;
		this.logDebug("[CalDAV] PROPFIND response:", text.substring(0, 2000)); // First 2000 chars for debug

		const hrefs: string[] = [];
		const hrefRegex = /<d:href>([^<]+)<\/d:href>/g;
		let match;
		while ((match = hrefRegex.exec(text)) !== null) {
			const href = match[1];
			this.logDebug("[CalDAV] Found href:", href);
			// Only include .ics files (not the calendar itself)
			if (href.endsWith(".ics")) {
				hrefs.push(href);
			}
		}
		this.logDebug("[CalDAV] Parsed hrefs:", hrefs);
		return hrefs;
	}

	/**
	 * Get existing events with their UIDs for sync diff calculation
	 */
	private async getExistingEventsWithUIDs(
		baseUrl: string,
		authHeader: string
	): Promise<{ href: string; uid: string }[]> {
		// Use cal:calendar-data instead of d:uid since UID is stored inside ICS content, not as WebDAV prop
		const response = await requestUrl({
			url: baseUrl,
			method: "PROPFIND",
			headers: {
				Authorization: authHeader,
				"Content-Type": "application/xml; charset=utf-8",
				Depth: "1",
			},
			body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><D:prop><D:href/><cal:calendar-data/></D:prop></D:propfind>',
			throw: false,
		});

		if (response.status >= 400) {
			console.warn(
				`[CalDAV] PROPFIND failed with HTTP ${response.status}, assuming empty calendar`
			);
			return [];
		}

		const text = response.text;
		const events: { href: string; uid: string }[] = [];

		// Match href and calendar-data pairs
		const hrefRegex = /<d:href>([^<]+)<\/d:href>/g;
		const calDataRegex = /<cal:calendar-data>([\s\S]*?)<\/cal:calendar-data>/g;

		const hrefMatches = [...text.matchAll(hrefRegex)];
		const calDataMatches = [...text.matchAll(calDataRegex)];

		this.logDebug(
			`[CalDAV] Regex matches - href: ${hrefMatches.length}, calendar-data: ${calDataMatches.length}`
		);

		// Pair up hrefs with calendar-data and extract UID from ICS content
		for (let i = 0; i < hrefMatches.length; i++) {
			const href = hrefMatches[i][1];
			// Only include .ics files (not the calendar itself)
			if (href.endsWith(".ics")) {
				const calData = calDataMatches[i]?.[1] || "";
				// Extract UID from inside the ICS content
				const uidMatch = calData.match(/^UID:(.+)$/m);
				const uid = uidMatch?.[1] || "";
				events.push({ href, uid });
			}
		}

		this.logDebug(`[CalDAV] Parsed ${events.length} events with UIDs`);
		return events;
	}

	private async deleteEvent(
		baseUrl: string,
		authHeader: string,
		eventHref: string
	): Promise<void> {
		// Handle URLs - Nextcloud returns absolute paths like /remote.php/dav/...
		let deleteUrl: string;
		if (eventHref.startsWith("http")) {
			// Full URL already
			deleteUrl = eventHref;
		} else if (eventHref.startsWith("/remote.php")) {
			// Absolute path - extract origin from baseUrl
			const urlObj = new URL(baseUrl);
			deleteUrl = urlObj.origin + eventHref;
		} else {
			// Relative path
			const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
			deleteUrl = base + eventHref;
		}

		const response = await requestUrl({
			url: deleteUrl,
			method: "DELETE",
			headers: {
				Authorization: authHeader,
			},
			throw: false,
		});

		// 404 or 204 are both considered success (already deleted or deleted now)
		if (response.status !== 204 && response.status !== 404 && response.status >= 400) {
			throw new Error(`HTTP ${response.status}: ${response.text}`);
		}
	}

	private async pushSingleTask(
		task: TaskInfo,
		options: CalDAVPushOptions,
		baseUrl: string,
		authHeader: string
	): Promise<{ id: string; url: string }> {
		// Use existing caldavEventId if available (for updates), otherwise generate new UUID (for creates)
		const eventId = task.caldavEventId || crypto.randomUUID();

		const icsContent = CalendarExportService.generateMultipleTasksICSContent([task], {
			includeReminders: options.includeReminders,
			includeRecurrence: options.includeRecurrence,
			useDurationForExport: options.useDurationForExport,
		});

		let veventMatch = icsContent.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/);
		if (!veventMatch) {
			throw new Error("Failed to generate VEVENT");
		}

		// Unfold ICS lines first (RFC 5545 line folding - lines > 75 chars wrap with space)
		// This ensures our UID replacement works correctly on folded UIDs
		const unfoldedVevent = veventMatch[0].replace(/\r\n[ \t]/g, "");

		// Replace the UID in the VEVENT with our stable UUID
		const veventContent = unfoldedVevent.replace(/^UID:.*$/m, `UID:${eventId}`);

		const calendarUrl = `${baseUrl}${eventId}.ics`;

		const response = await requestUrl({
			url: calendarUrl,
			method: "PUT",
			headers: {
				Authorization: authHeader,
				"Content-Type": "text/calendar; charset=utf-8",
			},
			body: this.wrapInICSCalendar(veventContent),
			throw: false,
		});

		if (response.status >= 400) {
			console.error(`[CalDAV] PUT failed with HTTP ${response.status}:`, response.text);
			throw new Error(`HTTP ${response.status}: ${response.text}`);
		}

		return { id: eventId, url: calendarUrl };
	}

	private extractUID(task: TaskInfo): string {
		const pathHash = task.path.replace(/[^a-zA-Z0-9]/g, "-").slice(-50);
		return `tasknotes-${pathHash}`;
	}

	private wrapInICSCalendar(vevent: string): string {
		const now = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d{3}/, "");
		return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//TaskNotes//EN
CALSCALE:GREGORIAN
${vevent}
END:VCALENDAR`;
	}
}
