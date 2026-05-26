import { Notice, TFile, parseYaml } from "obsidian";
import TaskNotesPlugin from "../main";
import { CalendarExportService } from "./CalendarExportService";
import { CalDAVService } from "./CalDAVService";
import type { InterpolationValues, TranslationKey } from "../i18n";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import { publishUserNotice } from "../core/userNotices";
import { createVaultFile } from "./VaultMutationService";
import type {
	FilterQuery,
	FilterOperator,
	FilterProperty,
	FilterCondition,
	TaskInfo,
} from "../types";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/AutoExportService" });

export class AutoExportService {
	private plugin: TaskNotesPlugin;
	private intervalId: number | null = null;
	private caldavIntervalId: number | null = null;
	private lastExportTime: Date | null = null;
	private nextExportTime: Date | null = null;
	private lastCalDAVExportTime: Date | null = null;
	private nextCalDAVExportTime: Date | null = null;
	private caldavService: CalDAVService | null = null;

	constructor(plugin: TaskNotesPlugin) {
		this.plugin = plugin;
		this.caldavService = new CalDAVService(plugin);
	}

	private translate(key: TranslationKey, variables?: Record<string, any>): string {
		return this.plugin.i18n.translate(key, variables);
	}

	/**
	 * Start the automatic export service
	 */
	start(): void {
		this.stop(); // Stop any existing intervals

		// Start ICS auto-export if enabled
		if (this.plugin.settings.icsIntegration.enableAutoExport) {
			const intervalMinutes = this.plugin.settings.icsIntegration.autoExportInterval;
			const intervalMs = intervalMinutes * 60 * 1000;

			this.nextExportTime = new Date(Date.now() + intervalMs);

			this.intervalId = setInterval(async () => {
				await this.performICSExport();
				this.nextExportTime = new Date(Date.now() + intervalMs);
			}, intervalMs) as unknown as number;

			console.log(
				`TaskNotes: ICS auto-export started (interval: ${intervalMinutes} minutes)`
			);
		}

		// Start CalDAV auto-export if enabled
		if (this.plugin.settings.caldavExport.enableAutoExport) {
			this.startCalDAVExport();
		}
	}

	/**
	 * Start the CalDAV auto-export service
	 */
	startCalDAVExport(): void {
		if (this.caldavIntervalId) {
			clearInterval(this.caldavIntervalId);
		}

		const intervalMinutes = this.plugin.settings.caldavExport.autoExportInterval;
		const intervalMs = intervalMinutes * 60 * 1000;

		this.nextCalDAVExportTime = new Date(Date.now() + intervalMs);

		this.caldavIntervalId = setInterval(async () => {
			await this.performCalDAVExport();
			this.nextCalDAVExportTime = new Date(Date.now() + intervalMs);
		}, intervalMs) as unknown as number;

		console.log(`TaskNotes: CalDAV auto-export started (interval: ${intervalMinutes} minutes)`);
	}

	/**
	 * Stop the CalDAV auto-export service
	 */
	stopCalDAVExport(): void {
		if (this.caldavIntervalId) {
			clearInterval(this.caldavIntervalId);
			this.caldavIntervalId = null;
			this.nextCalDAVExportTime = null;
		}
	}

	/**
	 * Stop the automatic export service
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.nextExportTime = null;
		}
		if (this.caldavIntervalId) {
			clearInterval(this.caldavIntervalId);
			this.caldavIntervalId = null;
			this.nextCalDAVExportTime = null;
		}
	}

	/**
	 * Update the export interval and restart the service
	 */
	updateInterval(newIntervalMinutes: number): void {
		if (this.plugin.settings.icsIntegration.enableAutoExport) {
			this.start(); // This will stop and restart with new interval
		}
	}

	/**
	 * Manually trigger an ICS export only
	 */
	async exportICSNow(): Promise<void> {
		await this.performICSExport();
	}

	/**
	 * Manually trigger a CalDAV export only
	 */
	async exportCalDAVNow(): Promise<void> {
		await this.performCalDAVExport();
	}

	/**
	 * Get the last export time
	 */
	getLastExportTime(): Date | null {
		return this.lastExportTime;
	}

	/**
	 * Get the next scheduled export time
	 */
	getNextExportTime(): Date | null {
		return this.nextExportTime;
	}

	/**
	 * Get the last CalDAV export time
	 */
	getLastCalDAVExportTime(): Date | null {
		return this.lastCalDAVExportTime;
	}

	/**
	 * Get the next scheduled CalDAV export time
	 */
	getNextCalDAVExportTime(): Date | null {
		return this.nextCalDAVExportTime;
	}

	/**
	 * Perform the ICS export only
	 */
	private async performICSExport(): Promise<void> {
		try {
			const exportPath =
				this.plugin.settings.icsIntegration.autoExportPath || "tasknotes-calendar.ics";

			let allTasks = await this.plugin.cacheManager.getAllTasks();

			if (allTasks.length === 0) {
				console.log("TaskNotes: ICS export skipped - no tasks found");
				return;
			}

			// Apply Bases view filter if enabled
			if (
				this.plugin.settings.icsIntegration.enableBasesViewFilter &&
				this.plugin.settings.icsIntegration.icsExportBaseViewPath
			) {
				const filterResult = await this.getTasksFilteredByBasesView(
					this.plugin.settings.icsIntegration.icsExportBaseViewPath,
					allTasks,
					"ics"
				);

				if (!filterResult.success) {
					console.warn(`[TaskNotes] Bases view filter error: ${filterResult.error}`);
				} else if (filterResult.tasks) {
					allTasks = filterResult.tasks;
					console.log(
						`[TaskNotes] ICS exported ${allTasks.length} tasks (filtered from original)`
					);
				}
			}

			const exportOptions = {
				useDurationForExport: this.plugin.settings.icsIntegration.useDurationForExport,
				includeRecurrence: this.plugin.settings.icsIntegration.exportRecurringAsSeries,
				includeReminders: this.plugin.settings.icsIntegration.includeRemindersAsValarms,
				exportFormat: this.plugin.settings.icsIntegration.exportFormat,
			};
			const icsContent = CalendarExportService.generateMultipleTasksICSContent(
				allTasks,
				exportOptions
			);

			const normalizedPath = exportPath;
			const fileExists = await this.plugin.app.vault.adapter.exists(normalizedPath);

			if (fileExists) {
				await this.plugin.app.vault.adapter.write(normalizedPath, icsContent);
			} else {
				await this.plugin.app.vault.create(normalizedPath, icsContent);
			}

			this.lastExportTime = new Date();
			console.log(
				`TaskNotes: ICS export completed - ${allTasks.length} tasks exported to ${exportPath}`
			);
		} catch (error) {
			console.error("TaskNotes: ICS export failed:", error);
			throw error;
		}
	}

	/**
	 * Perform the CalDAV export only
	 */
	private async performCalDAVExport(): Promise<void> {
		if (
			!this.plugin.settings.caldavExport.enabled ||
			!this.plugin.settings.caldavExport.acknowledgedWipeRisk
		) {
			console.log("TaskNotes: CalDAV export skipped - not enabled");
			return;
		}

		try {
			let caldavTasks = await this.plugin.cacheManager.getAllTasks();

			if (caldavTasks.length === 0) {
				console.log("TaskNotes: CalDAV export skipped - no tasks found");
				return;
			}

			// Apply CalDAV-specific Bases view filter if enabled
			if (
				this.plugin.settings.caldavExport.enableBasesViewFilter &&
				this.plugin.settings.caldavExport.caldavExportBaseViewPath
			) {
				const filterResult = await this.getTasksFilteredByBasesView(
					this.plugin.settings.caldavExport.caldavExportBaseViewPath,
					caldavTasks,
					"caldav"
				);

				if (!filterResult.success) {
					console.warn(
						`[TaskNotes] CalDAV Bases view filter error: ${filterResult.error}`
					);
				} else if (filterResult.tasks) {
					caldavTasks = filterResult.tasks;
					console.log(
						`[TaskNotes] CalDAV exported ${caldavTasks.length} tasks (filtered from original)`
					);
				}
			}

			const caldavResult = await this.caldavService!.pushEvents(caldavTasks, {
				includeReminders: this.plugin.settings.caldavExport.includeReminders,
				includeRecurrence: this.plugin.settings.caldavExport.includeRecurrence,
				useDurationForExport: this.plugin.settings.icsIntegration.useDurationForExport,
				concurrentExports: this.plugin.settings.caldavExport.concurrentExports,
				exportFormat: this.plugin.settings.caldavExport.exportFormat,
			});

			this.lastCalDAVExportTime = new Date();

			if (caldavResult.success) {
				console.log(
					`TaskNotes: CalDAV export completed - ${caldavResult.eventsPushed} tasks pushed`
				);
			} else {
				console.error(`TaskNotes: CalDAV export failed: ${caldavResult.errors.join(", ")}`);
				throw new Error(caldavResult.errors.join(", "));
			}
		} catch (caldavError) {
			console.error("TaskNotes: CalDAV export error:", caldavError);
			throw caldavError;
		}
	}

	/**
	 * Perform the actual export (both ICS and CalDAV)
	 * @deprecated Use exportICSNow() or exportCalDAVNow() instead
	 */
	private async performExport(): Promise<void> {
		try {
			// Perform ICS export
			await this.performICSExport();

			// Perform CalDAV export
			if (
				this.plugin.settings.caldavExport.enabled &&
				this.plugin.settings.caldavExport.acknowledgedWipeRisk
			) {
				await this.performCalDAVExport();
			}
		} catch (error) {
			console.error("TaskNotes: Auto export failed:", error);

			// Only show notice for manual exports or first few failures
			if (
				!this.lastExportTime ||
				Date.now() - this.lastExportTime.getTime() > 6 * 60 * 60 * 1000
			) {
				new Notice(
					this.translate("services.autoExport.notices.exportFailed", {
						error: error instanceof Error ? error.message : String(error),
					})
				);
			}
		}
	}

	/**
	 * Filter tasks using a Bases view
	 */
	public async getTasksFilteredByBasesView(
		viewPath: string,
		tasks: TaskInfo[],
		exportType: "ics" | "caldav" = "ics"
	): Promise<{ success: boolean; tasks?: TaskInfo[]; error?: string }> {
		const logPrefix = exportType === "caldav" ? "[CalDAV Filter]" : "[ICS Filter]";
		const isDebugEnabled = this.plugin.settings.caldavExport?.enableDebugLogging ?? false;

		let baseFilePath: string;
		let viewName: string | null = null;

		if (viewPath.includes("#")) {
			const parts = viewPath.split("#");
			baseFilePath = parts[0];
			viewName = parts.length > 1 ? parts[1] : null;
		} else {
			baseFilePath = viewPath;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(baseFilePath);
		if (!file || !(file instanceof TFile)) {
			return {
				success: false,
				error: this.translate(
					"settings.integrations.calendarSubscriptions.basesViewFilter.notices.fileNotFound",
					{ path: baseFilePath }
				),
			};
		}

		let parsedYaml: any;
		try {
			const content = await this.plugin.app.vault.read(file);
			parsedYaml = parseYaml(content) || {};
		} catch (error) {
			return {
				success: false,
				error: `Failed to read/parse ${baseFilePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}

		let filters: any = null;

		// Get root-level filters from the .base file
		const rootFilters = parsedYaml.filters;

		if (viewName) {
			const views = parsedYaml.views || [];
			const matchedView = views.find(
				(v: any) =>
					v.name === viewName || v.name === `"${viewName}"` || v.name === `'${viewName}'`
			);

			if (matchedView) {
				const viewFilters = matchedView.filters;

				// Combine root filters AND view filters (both must match)
				if (rootFilters && viewFilters) {
					filters = { and: [rootFilters, viewFilters] };
				} else if (viewFilters) {
					filters = viewFilters;
				} else if (rootFilters) {
					filters = rootFilters;
				}
			} else {
				return {
					success: false,
					error: this.translate(
						"settings.integrations.calendarSubscriptions.basesViewFilter.notices.viewNotFound",
						{ viewName, path: baseFilePath }
					),
				};
			}
		} else {
			const views = parsedYaml.views || [];
			if (views.length > 0) {
				const viewFilters = views[0].filters;
				// Combine root filters AND first view's filters
				if (rootFilters && viewFilters) {
					filters = { and: [rootFilters, viewFilters] };
				} else if (viewFilters) {
					filters = viewFilters;
				} else {
					filters = rootFilters;
				}
			} else {
				filters = rootFilters;
			}
		}

		if (!filters) {
			console.warn(`[TaskNotes] No filters found in ${baseFilePath}, exporting all tasks`);
			return { success: true, tasks };
		}

		if (isDebugEnabled) {
			console.log(`${logPrefix} Using filters:`, JSON.stringify(filters, null, 2));
		}

		const filterQuery = this.convertBasesFiltersToQuery(filters);

		if (!filterQuery || !filterQuery.children || filterQuery.children.length === 0) {
			console.warn(`[TaskNotes] No valid filter conditions found, exporting all tasks`);
			return { success: true, tasks };
		}

		try {
			const filteredTasks = tasks.filter((task) => {
				try {
					const result = this.plugin.filterService.evaluateFilterNode(filterQuery, task);
					if (!result && isDebugEnabled) {
						console.log(`${logPrefix} Excluded: ${task.title} (path: ${task.path})`);
					}
					return result;
				} catch (error) {
					console.debug(`[TaskNotes] Error evaluating task ${task.path}:`, error);
					return true;
				}
			});

			return { success: true, tasks: filteredTasks };
		} catch (error) {
			console.error(`[TaskNotes] Filter evaluation error:`, error);
			return { success: true, tasks };
		}
	}

	private convertBasesFiltersToQuery(filters: any): FilterQuery | null {
		if (!filters) {
			return null;
		}

		if (filters && typeof filters === "object" && filters.and) {
			return this.createGroupQuery("and", filters.and);
		}
		if (filters && typeof filters === "object" && filters.or) {
			return this.createGroupQuery("or", filters.or);
		}

		if (Array.isArray(filters)) {
			return this.createGroupQuery("and", filters);
		}

		return null;
	}

	private createGroupQuery(conjunction: "and" | "or", expressions: any): FilterQuery | null {
		if (!expressions || !Array.isArray(expressions)) {
			return null;
		}

		const children: FilterQuery["children"] = [];
		let childId = 0;
		for (const expr of expressions) {
			if (expr === null || expr === undefined) {
				continue;
			}

			const child = this.parseBasesExpression(expr, childId++);
			if (child !== null) {
				children.push(child);
			}
		}

		if (children.length === 0) {
			return null;
		}

		return {
			type: "group",
			id: `bases-filter-${Date.now()}`,
			conjunction,
			children,
		};
	}

	private parseBasesExpression(expr: any, index: number): FilterQuery["children"][number] | null {
		// CRITICAL: Check for nested group objects BEFORE other parsing
		// This handles YAML structures like: { and: ["!scheduled.isEmpty()"] }
		if (expr && typeof expr === "object" && (expr.and || expr.or)) {
			const innerQuery = this.convertBasesFiltersToQuery(expr);
			if (innerQuery) return innerQuery;
			return null;
		}

		// Handle string expressions (e.g., "!scheduled.isEmpty()", "file.hasTag("taskNote")")
		if (typeof expr === "string") {
			return this.parseStringExpression(expr, index);
		}

		if (!expr || typeof expr !== "object") {
			return null;
		}

		const innerQuery = this.convertBasesFiltersToQuery(expr);
		if (innerQuery) {
			return innerQuery;
		}

		const property = expr.property || expr.field || expr.key;
		if (!property) {
			return null;
		}

		const op = expr.operator || expr.op || "equals";
		let value = expr.value;

		// Normalize date values (e.g., "today()" -> "today")
		if (typeof value === "string") {
			value = this.normalizeDateValue(value);
		}

		const filterOperator = this.mapOperator(op);

		// Map property name using FieldMapper for user-configured field names
		const mappedProperty = this.mapBasesPropertyToTaskNotes(property);

		return {
			type: "condition",
			id: `bases-filter-${Date.now()}-${index}`,
			property: mappedProperty as FilterProperty,
			operator: filterOperator,
			value: value,
		};
	}

	/**
	 * Parse a Bases string expression into a FilterCondition
	 * Handles patterns like: "!scheduled.isEmpty()", "file.hasTag("taskNote")", "status == "todo""
	 */
	private parseStringExpression(expr: string, index: number): FilterCondition | null {
		const trimmed = expr.trim();

		// 1. Handle negated isEmpty: "!property.isEmpty()"
		const negatedEmptyMatch = trimmed.match(/^!(.+)\.isEmpty\(\)$/);
		if (negatedEmptyMatch) {
			const property = this.mapBasesPropertyToTaskNotes(negatedEmptyMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "is-not-empty",
				value: null,
			};
		}

		// 2. Handle isEmpty: "property.isEmpty()"
		const emptyMatch = trimmed.match(/^(.+)\.isEmpty\(\)$/);
		if (emptyMatch) {
			const property = this.mapBasesPropertyToTaskNotes(emptyMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "is-empty",
				value: null,
			};
		}

		// 3. Handle hasTag: "file.hasTag("value")"
		const hasTagMatch = trimmed.match(/^file\.hasTag\("([^"]+)"\)$/);
		if (hasTagMatch) {
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: "tags" as FilterProperty,
				operator: "contains",
				value: hasTagMatch[1],
			};
		}

		// 4. Handle contains: "property.contains("value")"
		const containsMatch = trimmed.match(/^(.+)\.contains\("([^"]+)"\)$/);
		if (containsMatch) {
			const property = this.mapBasesPropertyToTaskNotes(containsMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "contains",
				value: containsMatch[2],
			};
		}

		// 5. Handle startsWith: "property.startsWith("value")"
		const startsWithMatch = trimmed.match(/^(.+)\.startsWith\("([^"]+)"\)$/);
		if (startsWithMatch) {
			const property = this.mapBasesPropertyToTaskNotes(startsWithMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "contains", // Use contains as approximation for startsWith
				value: startsWithMatch[2],
			};
		}

		// 6. Handle comparisons: "property <= value", "property < value", etc.
		const comparisonMatch = trimmed.match(/^(.+)\s*(<=|>=|<|>)\s*(.+)$/);
		if (comparisonMatch) {
			const property = this.mapBasesPropertyToTaskNotes(comparisonMatch[1]);
			const comparator = comparisonMatch[2];
			let value = comparisonMatch[3].trim();
			value = this.normalizeDateValue(value);

			let operator: FilterOperator;
			switch (comparator) {
				case "<=":
					operator = "is-on-or-before";
					break;
				case ">=":
					operator = "is-on-or-after";
					break;
				case "<":
					operator = "is-before";
					break;
				case ">":
					operator = "is-after";
					break;
				default:
					operator = "is";
			}

			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator,
				value,
			};
		}

		// 7. Handle equality: "property == "value"" or "property = "value""
		const equalityMatch = trimmed.match(/^(.+?)\s*(==|=)\s*"([^"]+)"$/);
		if (equalityMatch) {
			const property = this.mapBasesPropertyToTaskNotes(equalityMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "is",
				value: equalityMatch[3],
			};
		}

		// 8. Handle not equal: "property != "value""
		const notEqualMatch = trimmed.match(/^(.+?)\s*!=\s*"([^"]+)"$/);
		if (notEqualMatch) {
			const property = this.mapBasesPropertyToTaskNotes(notEqualMatch[1]);
			// Handle empty string check: "status != "" means "is not empty"
			if (notEqualMatch[2] === "") {
				return {
					type: "condition",
					id: `bases-filter-${Date.now()}-${index}`,
					property: property as FilterProperty,
					operator: "is-not-empty",
					value: null,
				};
			}
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "is-not",
				value: notEqualMatch[2],
			};
		}

		// 9. Handle simple negated check: "!property" (treat as is-not-empty)
		const negatedSimpleMatch = trimmed.match(/^!(.+)$/);
		if (negatedSimpleMatch) {
			const property = this.mapBasesPropertyToTaskNotes(negatedSimpleMatch[1]);
			return {
				type: "condition",
				id: `bases-filter-${Date.now()}-${index}`,
				property: property as FilterProperty,
				operator: "is-not-empty",
				value: null,
			};
		}

		// Unknown expression format - return null (will be skipped, fail-open)
		console.debug(`[TaskNotes] Unknown Bases expression format: ${trimmed}`);
		return null;
	}

	/**
	 * Map Bases property names to TaskNotes internal field names
	 * Uses FieldMapper for user-configured field names
	 */
	private mapBasesPropertyToTaskNotes(basesProp: string): string {
		// Handle special Bases properties that aren't in FieldMapping
		const basesToInternal: Record<string, string> = {
			"file.tags": "tags",
			"file.hasTag": "tags",
			"file.folder": "path", // Special: extract folder from task path
			"file.path": "path",
			"file.name": "title",
			"file.ctime": "dateCreated",
			"file.mtime": "dateModified",
		};

		// Check hardcoded Bases properties first
		if (basesToInternal[basesProp]) {
			return basesToInternal[basesProp];
		}

		// Remove "note." prefix if present (e.g., "note.status" -> "status")
		let propName = basesProp.startsWith("note.") ? basesProp.slice(5) : basesProp;

		// Use FieldMapper to convert user-configured name to internal name
		if (this.plugin.fieldMapper) {
			const internalName = this.plugin.fieldMapper.lookupMappingKey(propName);
			if (internalName) {
				return internalName;
			}
		}

		// Fall back to the property name as-is
		return propName;
	}

	/**
	 * Normalize date values from Bases expressions
	 * Converts functions like "today()" to the special "today" value
	 */
	private normalizeDateValue(value: string): string {
		if (value === "today()" || value === "today") {
			return "today";
		}
		if (value === "now()" || value === "now") {
			return "today";
		}
		// Remove trailing () from other date functions
		return value.replace(/\(\)$/, "");
	}

	private mapOperator(op: string): FilterOperator {
		const opMap: Record<string, FilterOperator> = {
			equals: "is",
			"==": "is",
			"!=": "is-not",
			is: "is",
			is_not: "is-not",
			contains: "contains",
			not_contains: "does-not-contain",
			matches: "contains",
			before: "is-before",
			after: "is-after",
			is_before: "is-before",
			is_after: "is-after",
			exists: "is-not-empty",
			not_exists: "is-empty",
			is_empty: "is-empty",
			is_not_empty: "is-not-empty",
		};

		return opMap[op] || "is";
	}

	/**
	 * Clean up when the service is destroyed
	 */
	destroy(): void {
		this.stop();
	}
}
