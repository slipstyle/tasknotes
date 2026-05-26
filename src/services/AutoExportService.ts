import { TFile, parseYaml } from "obsidian";
import TaskNotesPlugin from "../main";
import { CalendarExportService } from "./CalendarExportService";
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
	private scheduledExportId: number | null = null;
	private lastExportTime: Date | null = null;
	private nextExportTime: Date | null = null;
	private isRunning = false;

	constructor(plugin: TaskNotesPlugin) {
		this.plugin = plugin;
	}

	private translate(key: TranslationKey, variables?: InterpolationValues): string {
		return this.plugin.i18n.translate(key, variables);
	}

	/**
	 * Start the automatic export service
	 */
	start(): void {
		if (!this.plugin.settings.icsIntegration.enableAutoExport) {
			return;
		}

		this.stop();
		this.isRunning = true;

		this.scheduleNextExport();
	}

	/**
	 * Stop the automatic export service
	 */
	stop(): void {
		this.isRunning = false;
		if (this.scheduledExportId !== null) {
			window.clearTimeout(this.scheduledExportId);
			this.scheduledExportId = null;
		}
		this.nextExportTime = null;
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
	 * Manually trigger an export
	 */
	async exportNow(): Promise<void> {
		await this.performExport();
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

	private scheduleNextExport(): void {
		if (!this.isRunning || !this.plugin.settings.icsIntegration.enableAutoExport) {
			this.nextExportTime = null;
			return;
		}

		const intervalMinutes = this.plugin.settings.icsIntegration.autoExportInterval;
		const intervalMs = intervalMinutes * 60 * 1000;
		this.nextExportTime = new Date(Date.now() + intervalMs);

		this.scheduledExportId = window.setTimeout(() => {
			this.scheduledExportId = null;
			void this.performExport().finally(() => {
				if (this.isRunning) {
					this.scheduleNextExport();
				}
			});
		}, intervalMs);
	}

	/**
	 * Perform the actual export
	 */
	private async performExport(): Promise<void> {
		try {
			const exportPath =
				this.plugin.settings.icsIntegration.autoExportPath || "tasknotes-calendar.ics";

			// Get all tasks
			let allTasks = await this.plugin.cacheManager.getAllTasks();

			if (allTasks.length === 0) {
				return;
			}

			// Apply Bases view filter if enabled
			if (
				this.plugin.settings.icsIntegration.enableBasesViewFilter &&
				this.plugin.settings.icsIntegration.icsExportBaseViewPath
			) {
				const filterResult = await this.getTasksFilteredByBasesView(
					this.plugin.settings.icsIntegration.icsExportBaseViewPath,
					allTasks
				);

				if (!filterResult.success) {
					console.warn(`[TaskNotes] Bases view filter error: ${filterResult.error}`);
				} else if (filterResult.tasks) {
					allTasks = filterResult.tasks;
					console.log(
						`[TaskNotes] Exported ${allTasks.length} tasks (filtered from original)`
					);
				}
			}

			// Generate ICS content with export options from settings
			const exportOptions = {
				useDurationForExport: this.plugin.settings.icsIntegration.useDurationForExport,
				excludeArchived:
					this.plugin.settings.icsIntegration.excludeArchivedFromExport ?? false,
				excludeCompleted:
					this.plugin.settings.icsIntegration.excludeCompletedFromExport ?? false,
				completedStatuses: this.plugin.statusManager.getCompletedStatuses(),
				requireDueDate:
					this.plugin.settings.icsIntegration.requireDueDateForExport ?? false,
				requireScheduledDate:
					this.plugin.settings.icsIntegration.requireScheduledDateForExport ?? false,
				includeObsidianLink: true,
				vaultName: this.plugin.app.vault.getName(),
				includeRecurrence: this.plugin.settings.icsIntegration.exportRecurringAsSeries,
				includeReminders: this.plugin.settings.icsIntegration.includeRemindersAsValarms,
			};
			const icsContent = CalendarExportService.generateMultipleTasksICSContent(
				allTasks,
				exportOptions
			);

			// Write to file - use path as-is since Obsidian handles normalization
			const normalizedPath = exportPath;

			// Check if file exists
			const fileExists = await this.plugin.app.vault.adapter.exists(normalizedPath);

			if (fileExists) {
				// Update existing file
				await this.plugin.app.vault.adapter.write(normalizedPath, icsContent);
			} else {
				// Create new file
				await createVaultFile(this.plugin.app, normalizedPath, icsContent);
			}

			this.lastExportTime = new Date();
		} catch (error) {
			tasknotesLogger.error("TaskNotes: Auto export failed:", {
				category: "provider",
				operation: "auto-export",
				error: error,
			});

			// Only show notice for manual exports or first few failures
			if (
				!this.lastExportTime ||
				Date.now() - this.lastExportTime.getTime() > 6 * 60 * 60 * 1000
			) {
				publishUserNotice(this.plugin.emitter,
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
		tasks: TaskInfo[]
	): Promise<{ success: boolean; tasks?: TaskInfo[]; error?: string }> {
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

		const filterQuery = this.convertBasesFiltersToQuery(filters);

		if (!filterQuery || !filterQuery.children || filterQuery.children.length === 0) {
			console.warn(`[TaskNotes] No valid filter conditions found, exporting all tasks`);
			return { success: true, tasks };
		}

		try {
			const filteredTasks = tasks.filter((task) => {
				try {
					return this.plugin.filterService.evaluateFilterNode(filterQuery, task);
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
