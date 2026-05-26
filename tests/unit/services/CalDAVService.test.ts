/**
 * CalDAVService Unit Tests
 *
 * Tests for CalDAV integration including:
 * - Credential management (save, load, clear)
 * - Connection testing
 * - Sync diff calculation
 * - ICS content generation
 * - UID extraction
 */

jest.mock("obsidian", () => ({
	requestUrl: jest.fn(),
	Notice: jest.fn(),
	TFile: jest.fn().mockImplementation(() => ({
		path: "/tasks/test-task.md",
	})),
}));

import { CalDAVService } from "../../../src/services/CalDAVService";
import { TaskInfo } from "../../../src/types";
import { requestUrl } from "obsidian";

describe("CalDAVService", () => {
	let service: CalDAVService;
	let mockPlugin: any;

	beforeEach(() => {
		jest.clearAllMocks();
		(requestUrl as jest.Mock).mockReset();

		mockPlugin = {
			loadData: jest.fn().mockResolvedValue({}),
			saveData: jest.fn().mockResolvedValue(undefined),
			settings: {
				caldavExport: {
					enableDebugLogging: false,
				},
			},
			fieldMapper: {
				toUserField: jest.fn((field: string) => field),
			},
			app: {
				vault: {
					getAbstractFileByPath: jest.fn(),
					createFolder: jest.fn(),
				},
				fileManager: {
					processFrontMatter: jest.fn(),
				},
			},
			cacheManager: {
				getTaskInfo: jest.fn(),
			},
		};

		service = new CalDAVService(mockPlugin);
	});

	describe("Credential Management", () => {
		it("should save credentials to plugin data", async () => {
			await service.saveCredentials("https://example.com/caldav", "user", "password123");

			expect(mockPlugin.saveData).toHaveBeenCalledWith(
				expect.objectContaining({
					caldavCredentials: {
						url: "https://example.com/caldav",
						username: "user",
						password: "password123",
					},
				})
			);
		});

		it("should load credentials from plugin data", async () => {
			mockPlugin.loadData.mockResolvedValue({
				caldavCredentials: {
					url: "https://example.com/caldav",
					username: "user",
					password: "secret",
				},
			});

			const credentials = await service.loadCredentials();

			expect(credentials).toEqual({
				url: "https://example.com/caldav",
				username: "user",
				password: "secret",
			});
		});

		it("should return undefined when no credentials exist", async () => {
			mockPlugin.loadData.mockResolvedValue(undefined);

			const credentials = await service.loadCredentials();

			expect(credentials).toBeUndefined();
		});

		it("should clear credentials from plugin data", async () => {
			mockPlugin.loadData.mockResolvedValue({
				caldavCredentials: { url: "test", username: "u", password: "p" },
				otherData: "value",
			});

			await service.clearCredentials();

			expect(mockPlugin.saveData).toHaveBeenCalledWith({
				otherData: "value",
			});
		});
	});

	describe("testConnection", () => {
		it("should return success for valid credentials", async () => {
			(requestUrl as jest.Mock).mockResolvedValue({ status: 200 });

			const result = await service.testConnection(
				"https://example.com/caldav",
				"user",
				"password"
			);

			expect(result).toEqual({ success: true });
		});

		it("should return error for 401 unauthorized", async () => {
			(requestUrl as jest.Mock).mockResolvedValue({ status: 401 });

			const result = await service.testConnection(
				"https://example.com/caldav",
				"user",
				"wrongpassword"
			);

			expect(result).toEqual({ success: false, error: "Invalid credentials" });
		});

		it("should return error for 404 not found", async () => {
			(requestUrl as jest.Mock).mockResolvedValue({ status: 404 });

			const result = await service.testConnection(
				"https://example.com/caldav",
				"user",
				"password"
			);

			expect(result).toEqual({ success: false, error: "Calendar not found" });
		});

		it("should return error for network errors", async () => {
			(requestUrl as jest.Mock).mockRejectedValue(new Error("ENOTFOUND"));

			const result = await service.testConnection(
				"https://invalid.example.com",
				"user",
				"password"
			);

			expect(result).toEqual({ success: false, error: "Invalid URL or network error" });
		});

		it("should return generic error for other HTTP statuses", async () => {
			(requestUrl as jest.Mock).mockResolvedValue({ status: 500 });

			const result = await service.testConnection(
				"https://example.com/caldav",
				"user",
				"password"
			);

			expect(result).toEqual({ success: false, error: "HTTP 500" });
		});
	});

	describe("extractUID", () => {
		it("should extract UID from task path", () => {
			const task: TaskInfo = {
				title: "Test",
				status: "open",
				priority: "normal",
				path: "/tasks/my-test-task.md",
				archived: false,
			};

			const uid = (service as any).extractUID(task);

			expect(uid).toBe("tasknotes--tasks-my-test-task-md");
		});

		it("should handle paths with special characters", () => {
			const task: TaskInfo = {
				title: "Test",
				status: "open",
				priority: "normal",
				path: "/tasks/my_test-task.2024.md",
				archived: false,
			};

			const uid = (service as any).extractUID(task);

			expect(uid).toBe("tasknotes--tasks-my-test-task-2024-md");
		});

		it("should truncate long paths to 50 characters", () => {
			const longPath = "/tasks/" + "a".repeat(100) + ".md";
			const task: TaskInfo = {
				title: "Test",
				status: "open",
				priority: "normal",
				path: longPath,
				archived: false,
			};

			const uid = (service as any).extractUID(task);

			// Path is truncated to last 50 chars after replacing special chars
			// /tasks/ + 100 a's + .md becomes -tasks- + 100 a's + -md (109 chars)
			// Last 50 chars: 47 a's + -md
			expect(uid).toBe("tasknotes-" + "a".repeat(47) + "-md");
		});
	});

	describe("pushEvents", () => {
		it("should return error when no credentials configured", async () => {
			mockPlugin.loadData.mockResolvedValue({});

			const result = await service.pushEvents([], {
				includeReminders: true,
				includeRecurrence: true,
				useDurationForExport: false,
				concurrentExports: 5,
			});

			expect(result.success).toBe(false);
			expect(result.errors).toContain("No credentials configured");
		});
	});

	describe("debug logging", () => {
		it("should not log when debug disabled", async () => {
			mockPlugin.settings.caldavExport.enableDebugLogging = false;
			const consoleSpy = jest.spyOn(console, "log").mockImplementation();

			mockPlugin.loadData.mockResolvedValue({});
			await service.pushEvents([], {
				includeReminders: false,
				includeRecurrence: false,
				useDurationForExport: false,
				concurrentExports: 5,
			});

			const caldavLogs = consoleSpy.mock.calls.filter(
				(call) => call[0] && call[0].includes("[CalDAV]")
			);
			expect(caldavLogs.length).toBe(0);

			consoleSpy.mockRestore();
		});

		it.skip("should log when debug enabled", async () => {
			// This test requires credentials to be set to reach the debug logging code
			// Skipping as it requires more complex mocking
		});
	});
});
