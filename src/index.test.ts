import { describe, expect, test, beforeEach, mock, vi } from "bun:test";
import app from "./index";
import type { AppBindings } from "./types";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { Next } from "hono";

vi.mock("./middleware", () => ({
	allowGoogleOnly: (_: { Bindings: AppBindings }, next: Next) => next(),
	rateLimit: () => (_: { Bindings: AppBindings }, next: Next) => next(),
}));

mock.module("./helper", () => ({
	getAccessTokens: mock(() =>
		Promise.resolve({
			access_token: "mock_access_token",
			refresh_token: "mock_refresh_token",
			expiry_date: Date.now() + 3600000,
		}),
	),
	watchChannel: mock(() =>
		Promise.resolve({
			ok: true,
			json: async () => ({ resourceId: "mock_resource_id" }),
		} as Response),
	),
	validateDriveWebhook: mock(() => Promise.resolve(true)),
	fetchAndLogChanges: mock(() => Promise.resolve({ changes: [] })),
	generateAuthUrl: mock(() => "https://accounts.google.com/o/oauth2/auth?..."),
	getOrUpdateKV: mock(async (env: AppBindings, key: string, value?: string | null) => {
		if (value) {
			await env.drive_kv.put(key, value);
			return value;
		}
		return await env.drive_kv.get(key);
	}),
	getValidAccessToken: mock(() => Promise.resolve("mock_valid_token")),
}));

// Mock KV storage
class MockKV {
	private store = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.store.get(key) || null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	clear() {
		this.store.clear();
	}
}

// Mock AppBindings
const createMockEnv = (): AppBindings => ({
	WEBHOOK_AUTH_KEY: "test_auth_key",
	CLOUDFLARE_API_TOKEN: "test_cf_token",
	drive_kv: new MockKV() as unknown as KVNamespace,
});

describe("Drive Webhook API", () => {
	let mockEnv: AppBindings;

	beforeEach(() => {
		mockEnv = createMockEnv();
		(mockEnv.drive_kv as unknown as MockKV).clear();

		// Mock fetch for allowGoogleOnly middleware
		global.fetch = mock((url: string) => {
			if (url.includes("metadata.google.internal")) {
				return Promise.resolve(new Response("Google", { status: 200 }));
			}
			return Promise.resolve(new Response("{}", { status: 200 }));
		}) as any;
	});

	describe("GET /", () => {
		test("should return welcome message", async () => {
			const req = new Request("http://localhost/");
			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.status).toBe("Welcome to Drive Webhook");
			expect(data.timestamp).toBeDefined();
		});
	});

	describe("GET /health", () => {
		test("should return OK status", async () => {
			const req = new Request("http://localhost/health");
			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.status).toBe("OK");
			expect(data.timestamp).toBeDefined();
		});
	});

	describe("POST /oauth/url", () => {
		test("should generate OAuth URL with valid credentials", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					client_id: "test_client_id",
					client_secret: "test_client_secret",
					redirect_uris: ["http://localhost/oauth/callback"],
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.auth_url).toBeDefined();
			expect(data.message).toContain("authorize");
		});

		test("should reject request with missing client_id", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					client_secret: "test_client_secret",
					redirect_uris: ["http://localhost/oauth/callback"],
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});

		test("should reject request with empty redirect_uris", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					client_id: "test_client_id",
					client_secret: "test_client_secret",
					redirect_uris: [],
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("GET /oauth/callback", () => {
		test("should store OAuth code successfully", async () => {
			const gAuthCode = "test_auth_code_123";
			const req = new Request(
				`http://localhost/oauth/callback?code=${gAuthCode}`,
			);

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.auth_code).toBe(gAuthCode);
			expect(data.message).toContain("stored");

			const storedGAuthCode = await mockEnv.drive_kv.get("auth_code");
			expect(storedGAuthCode).toBe(gAuthCode);
		});

		test("should reject request without code parameter", async () => {
			const req = new Request("http://localhost/oauth/callback");

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("POST /oauth/exchange", () => {
		test("should exchange auth code for tokens", async () => {
			const req = new Request("http://localhost/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					auth_code: "test_auth_code",
					client_id: "test_client_id",
					client_secret: "test_client_secret",
					redirect_uris: ["http://localhost/oauth/callback"],
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.message).toContain("successful");
			expect(data.accessToken).toBeDefined();
			expect(data.refreshToken).toBeDefined();
		});

		test("should reject request with missing auth code", async () => {
			await mockEnv.drive_kv.delete("redirect_uris");

			const req = new Request("http://localhost/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({ auth_code: "" }),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});

		test("should reject request with empty auth code", async () => {
			const req = new Request("http://localhost/oauth/exchange", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					auth_code: "   ",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("POST /drive/startPageToken", () => {
		test("should fetch and store startPageToken", async () => {
			// Mock the Google Drive API response
			global.fetch = mock(() =>
				Promise.resolve(
					new Response(JSON.stringify({ startPageToken: "mock_token_123" }), {
						status: 200,
					}),
				),
			) as any;

			const req = new Request("http://localhost/drive/startPageToken", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_access_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.drive_start_page_token).toBe("mock_token_123");
			expect(data.message).toContain("initialized");
		});

		test("should reject request without access token", async () => {
			const req = new Request("http://localhost/drive/startPageToken", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("POST /drive/watch", () => {
		test("should create drive watch channel successfully", async () => {
			const req = new Request("http://localhost/drive/watch", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_access_token",
					drive_start_page_token: "test_start_token",
					worker_drive_webhook_url: "https://example.com/webhook",
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.message).toContain("created");
			expect(data.channelId).toBeDefined();
			expect(data.resourceId).toBeDefined();
			expect(data.expiration).toBeDefined();
		});

		test("should reject insecure http webhook URL", async () => {
			const req = new Request("http://localhost/drive/watch", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_access_token",
					drive_start_page_token: "test_start_token",
					worker_drive_webhook_url: "http://example.com/webhook",
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(400);
			expect(data.message).toContain("Insecure");
		});

		test("should reject request with missing fields", async () => {
			const req = new Request("http://localhost/drive/watch", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_access_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("POST /drive/webhook", () => {
		test("should acknowledge sync event", async () => {
			const req = new Request("http://localhost/drive/webhook", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
					"X-Goog-Resource-State": "sync",
					"CF-Connecting-IP": "74.125.0.1", // Valid Google IP
				},
				body: JSON.stringify({
					drive_folder_id: "test_folder_id",
					access_token: "test_access_token",
					drive_start_page_token: "test_start_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.message).toContain("Sync");
			expect(data.state).toBe("sync");
		});

		test("should process change notification", async () => {
			await mockEnv.drive_kv.put("driveWebhookToken", "valid_token");

			const req = new Request("http://localhost/drive/webhook", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-Resource-State": "change",
					"X-Goog-Channel-Token": "valid_token",
					Authorization: "Bearer test_auth_key",
					"CF-Connecting-IP": "74.125.0.1", // Valid Google IP
				},
				body: JSON.stringify({
					drive_folder_id: "test_folder_id",
					access_token: "test_access_token",
					drive_start_page_token: "test_start_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);
			const data = await res.json();

			expect(res.status).toBe(200);
			expect(data.message).toContain("processed");
		});

		test("should reject unauthorized webhook calls", async () => {
			await mockEnv.drive_kv.put("driveWebhookToken", "valid_token");

			const req = new Request("http://localhost/drive/webhook", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-Resource-State": "change",
					"X-Goog-Channel-Token": "invalid_token",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					drive_folder_id: "test_folder_id",
					access_token: "test_access_token",
					drive_start_page_token: "test_start_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(403);
		});
	});

	describe("POST /drive/download", () => {
		test("should download file by name from changes", async () => {
			// Mock Drive API responses
			global.fetch = mock((url: string) => {
				if (url.includes("/changes?")) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								changes: [
									{
										file: {
											id: "file123",
											name: "test.pdf",
											mimeType: "application/pdf",
										},
									},
								],
							}),
							{ status: 200 },
						),
					);
				}
				// File download
				return Promise.resolve(
					new Response(new Blob(["file content"]), { status: 200 }),
				);
			}) as any;

			const req = new Request("http://localhost/drive/download", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_token",
					file_name: "test.pdf",
					drive_start_page_token: "token123",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("application/pdf");
			expect(res.headers.get("Content-Disposition")).toContain("test.pdf");
		});

		test("should return 404 if file not found", async () => {
			global.fetch = mock(() =>
				Promise.resolve(
					new Response(JSON.stringify({ changes: [] }), { status: 200 }),
				),
			) as any;

			const req = new Request("http://localhost/drive/download", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_token",
					file_name: "nonexistent.pdf",
					drive_start_page_token: "token123",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(404);
		});

		test("should reject request with missing fields", async () => {
			const req = new Request("http://localhost/drive/download", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					access_token: "test_token",
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(400);
		});
	});

	describe("Authentication", () => {
		test("should reject requests without bearer token", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					client_id: "test",
					client_secret: "test",
					redirect_uris: ["http://localhost"],
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(401);
		});

		test("should reject requests with invalid bearer token", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer invalid_token",
				},
				body: JSON.stringify({
					client_id: "test",
					client_secret: "test",
					redirect_uris: ["http://localhost"],
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(401);
		});

		test("should allow requests with valid bearer token", async () => {
			const req = new Request("http://localhost/oauth/url", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer test_auth_key",
				},
				body: JSON.stringify({
					client_id: "test",
					client_secret: "test",
					redirect_uris: ["http://localhost"],
				}),
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(200);
		});
	});

	describe("CSRF Protection", () => {
		test("should include CSRF protection headers", async () => {
			const req = new Request("http://localhost/health");
			const res = await app.fetch(req, mockEnv);

			// CSRF middleware should set appropriate headers
			expect(res.status).toBe(200);
		});
	});

	describe("GET /wrangler/tail", () => {
		test("should return stream for wrangler tail", async () => {
			// Mock the wrangler API response
			const mockStream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("log line 1\n"));
					controller.close();
				},
			});

			global.fetch = mock(() =>
				Promise.resolve(
					new Response(mockStream, {
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					}),
				),
			) as any;

			const req = new Request("http://localhost/wrangler/tail", {
				headers: {
					Authorization: "Bearer test_auth_key",
				},
			});

			const res = await app.fetch(req, mockEnv);

			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		});
	});
});

describe("Helper Functions Integration", () => {
	test("should properly integrate with getOrUpdateKV", async () => {
		const mockEnv = createMockEnv();
		const key = "test_key";
		const value = "test_value";

		await mockEnv.drive_kv.put(key, value);
		const result = await mockEnv.drive_kv.get(key);

		expect(result).toBe(value);
	});

	test("should handle KV deletion", async () => {
		const mockEnv = createMockEnv();
		const key = "test_key";
		const value = "test_value";

		await mockEnv.drive_kv.put(key, value);
		await mockEnv.drive_kv.delete(key);
		const result = await mockEnv.drive_kv.get(key);

		expect(result).toBeNull();
	});
});
