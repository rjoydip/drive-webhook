import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cache } from "hono/cache";
import { except } from "hono/combine";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { array, message, nonEmpty, object, pipe, string, trim } from "valibot";
import {
	fetchAndLogChanges,
	generateAuthUrl,
	getAccessTokens,
	getOrUpdateKV,
	getValidAccessToken,
	validateDriveWebhook,
} from "./helper";
import { allowGoogleOnly, rateLimit } from "./middleware";
import type { Bindings, OAuthSecrets } from "./types";
import { logger } from "./utils";

const app = new Hono<{ Bindings: Bindings }>();

/* -------------------------------------------------------------------------- */
/*                               Middleware	                                  */
/* -------------------------------------------------------------------------- */
app.use(csrf());
app.use(secureHeaders());

app.use("*", async (c, next) => {
	const path = c.req.path;

	// Health & root → higher limit
	if (path === "/health" || path === "/") {
		return rateLimit({
			windowMs: 60_000,
			max: 60,
		})(c, next);
	}

	// Drive APIs → stricter limit
	if (path.startsWith("/drive/")) {
		return rateLimit({
			windowMs: 60_000,
			max: 5,
		})(c, next);
	}

	// Everything else → no rate limit
	return next();
});

app.use(
	"*",
	except(
		["/", "/health", "/oauth/callback", "/drive/webhook"],
		async (c, next) =>
			await cache({
				cacheName: "drive-webhook-cache",
				cacheControl: c.req.path === "/health" ? "max-age=5" : "max-age=600",
			})(c, next),
		bearerAuth({
			verifyToken: (token, c) => token === c.env.WEBHOOK_AUTH_CLIENT_KEY,
		}),
	),
);

/* -------------------------------------------------------------------------- */
/*                               Wrangler Tail                                */
/* -------------------------------------------------------------------------- */

app.get("/wrangler/tail", async (c) => {
	logger.log("🚀 Starting Wrangler log tailing session");
	logger.log("🔗 Connecting to Realtime Wrangler API...");
	logger.info(
		"ℹ️ Note: Ensure your CLOUDFLARE_API_TOKEN has 'Logs:Read' scope.",
	);

	const wranglerResponse = await fetch(
		"https://api.realtime-wrangler.com/tail",
		{
			headers: {
				Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
			},
		},
	);

	const reader = wranglerResponse.body?.getReader();
	if (!reader) return c.text("No stream", 500);

	const stream = new ReadableStream({
		async start(controller) {
			const decoder = new TextDecoder();
			const encoder = new TextEncoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// Forward chunk to client
				controller.enqueue(encoder.encode(decoder.decode(value)));
			}

			controller.close();
		},
	});

	return c.body(stream, 200, { "Content-Type": "text/event-stream" });
});

/* -------------------------------------------------------------------------- */
/*                               Drive Handlers                               */
/* -------------------------------------------------------------------------- */

app.post(
	"/drive/webhook",
	allowGoogleOnly,
	sValidator(
		"json",
		object({
			google_drive_folder_id: message(
				pipe(string(), trim()),
				"Google Drive Folder ID is required",
			),
			google_access_token: message(
				pipe(string(), trim()),
				"Google Access Token is required",
			),
			google_drive_start_page_token: message(
				pipe(string(), trim()),
				"Google Drive Start Page Token is required",
			),
		}),
	),
	async (c) => {
		try {
			const state = c.req.header("X-Goog-Resource-State");

			// 🔄 Ignore initial sync
			if (state === "sync") {
				logger.log("🔄 Drive sync event received");
				return c.json({ message: "Sync acknowledged", state }, 200);
			}

			// 🔐 Validate webhook authenticity
			const receivedToken = c.req.header("X-Goog-Channel-Token");
			const expectedToken = await c.env.drive_kv.get("driveWebhookToken");

			if (!(await validateDriveWebhook(expectedToken, receivedToken))) {
				logger.error("🚨 Unauthorized Drive webhook call");
				return c.json({ message: "Unauthorized webhook" }, 401);
			}

			// 🔁 KV fallback/update
			const googleDriveFolderID = await getOrUpdateKV(
				c.env,
				"google_drive_folder_id",
				c.req.valid("json").google_drive_folder_id,
			);

			const googleDriveStartPageToken = await getOrUpdateKV(
				c.env,
				"google_drive_start_page_token",
				c.req.valid("json").google_drive_start_page_token,
			);

			const accessToken = await getOrUpdateKV(
				c.env,
				"accessToken",
				c.req.valid("json").google_access_token,
			);

			if (!accessToken || !googleDriveFolderID || !googleDriveStartPageToken) {
				return c.json({ message: "Missing required Drive configuration" }, 400);
			}

			logger.log("📩 Drive change notification received");

			const result = await fetchAndLogChanges(
				c.env,
				accessToken,
				googleDriveFolderID,
				googleDriveStartPageToken,
			);

			return c.json({ message: "Change processed", result }, 200);
		} catch (error: unknown) {
			logger.error(error);
			return c.json(
				{
					message: "Drive webhook processing failed",
					error: error instanceof Error ? error.message : "Unknown error",
				},
				500,
			);
		}
	},
);

app.post(
	"/drive/watch",
	sValidator(
		"json",
		object({
			google_access_token: message(
				pipe(string(), trim()),
				"Access token is required",
			),
			google_drive_start_page_token: message(
				pipe(string(), trim()),
				"Start page token is required",
			),
			worker_drive_webhook_url: message(
				pipe(string(), trim()),
				"Worker Drive Webhook URL is required",
			),
		}),
	),
	async (c) => {
		try {
			const body = c.req.valid("json");
			logger.log("👀 Creating Drive watch channel");

			// 1️⃣ Read Google Drive StartPage Token & Webhook URL
			const workerDriveWebhookUrl = await getOrUpdateKV(
				c.env,
				"worker_drive_webhook_url",
				body.worker_drive_webhook_url,
			);

			if (workerDriveWebhookUrl?.startsWith("http://")) {
				logger.warn("⚠️ Insecure webhook URL (http). Consider using https.");

				return c.json(
					{
						message:
							"Insecure webhook URL (http). Use https endpoint webhook URL.",
					},
					400,
				);
			}

			const startPageToken = await getOrUpdateKV(
				c.env,
				"google_drive_start_page_token",
				body.google_drive_start_page_token,
			);

			if (!workerDriveWebhookUrl || !startPageToken) {
				return c.json(
					{ message: "Missing webhook URL or start page token" },
					400,
				);
			}

			// 2️⃣ Generate expiration (24 hours)
			const EXPIRATION_MS = 24 * 60 * 60 * 1000;
			const expiration = Date.now() + EXPIRATION_MS;

			// 3️⃣ Get valid access token
			let accessToken = c.req.valid("json").google_access_token;

			if (!accessToken) {
				accessToken = await getValidAccessToken(c.env);

				if (!accessToken) {
					c.status(400);
					return c.json({ message: "Access token is required" });
				}
			}

			// 4️⃣ Generate channel metadata
			const channelId = crypto.randomUUID();
			const webhookToken = crypto.randomUUID(); // used for validation

			// 5️⃣ Create watch channel
			const res = await fetch(
				`https://www.googleapis.com/drive/v3/changes/watch?pageToken=${startPageToken}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						id: channelId,
						type: "web_hook",
						address: workerDriveWebhookUrl,
						expiration,
						token: webhookToken,
					}),
				},
			);

			if (!res.ok) {
				const error = await res.text();
				logger.error(`❌ Drive watch error: ${error}`);

				c.status(500);
				return c.json({
					message: "Failed to create watch channel",
					error,
				});
			}

			const data = await res.json();

			// 6️⃣ Persist channel metadata
			await Promise.all([
				c.env.drive_kv.put("driveChannelId", channelId),
				c.env.drive_kv.put("driveResourceId", data.resourceId),
				c.env.drive_kv.put("driveChannelExpiration", expiration.toString()),
				c.env.drive_kv.put("driveWebhookToken", webhookToken),
			]);

			logger.log("✅ Drive watch channel created");

			// 7️⃣ Respond
			c.status(200);
			return c.json({
				message: "Drive watch channel created",
				channelId,
				resourceId: data.resourceId,
				expiration,
				webhookToken,
			});
		} catch (error: unknown) {
			logger.error(error);

			c.status(500);
			return c.json({
				message: "Drive watch creation failed",
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	},
);

app.post(
	"/drive/startPageToken",
	sValidator(
		"json",
		object({
			google_access_token: message(
				pipe(string(), trim()),
				"Access token is required",
			),
		}),
	),
	async (c) => {
		const accessToken = await getOrUpdateKV(
			c.env,
			"accessToken",
			c.req.valid("json").google_access_token,
		);

		if (!accessToken) {
			return c.json({ message: "Access token missing" }, 400);
		}

		logger.log("🚀 Initializing Google Drive change tracking");

		// 2️⃣ Fetch startPageToken from Drive
		const res = await fetch(
			"https://www.googleapis.com/drive/v3/changes/startPageToken",
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		);

		if (!res.ok) {
			const error = await res.text();
			logger.error(`❌ Drive API error: ${error}`);

			return c.json(
				{
					message: "Failed to fetch startPageToken",
					error,
				},
				500,
			);
		}

		const { startPageToken } = await res.json();

		if (!startPageToken) {
			return c.json({ message: "StartPageToken missing in response" }, 500);
		}

		// 3️⃣ Store in KV (remote in prod automatically)
		await c.env.drive_kv.put("google_drive_start_page_token", startPageToken);

		logger.log(`✅ startPageToken stored: ${startPageToken}`);

		// 4️⃣ Respond
		return c.json(
			{
				message: "Drive change tracking initialized",
				google_drive_start_page_token: startPageToken,
			},
			200,
		);
	},
);

/* -------------------------------------------------------------------------- */
/*                               OAuth Handlers                                */
/* -------------------------------------------------------------------------- */

/**
 * Exchange Google OAuth code for tokens
 */
app.post(
	"/oauth/exchange",
	sValidator(
		"json",
		object({
			google_auth_code: message(
				pipe(string(), trim(), nonEmpty("Google Auth Code shouldn't be empty")),
				"OAuth2 code is required",
			),
		}),
	),
	async (c) => {
		const authCode = c.req.valid("json").google_auth_code;

		if (!authCode) {
			logger.error("❌ Missing Google OAuth code");
			return c.json({ message: "Missing Google OAuth code" }, 400);
		}

		try {
			const token = await getAccessTokens(authCode);

			await Promise.all([
				c.env.drive_kv.put("accessToken", token.access_token ?? ""),
				c.env.drive_kv.put(
					"accessTokenExpiry",
					token.expiry_date?.toString() ?? "",
				),
				c.env.drive_kv.put("refreshToken", token.refresh_token ?? ""),
			]);

			logger.log("✅ OAuth tokens stored in KV");

			return c.json(
				{
					message: "Token exchange successful",
					accessToken: token.access_token,
					refreshToken: token.refresh_token,
					expiry_date: token.expiry_date,
				},
				200,
			);
		} catch (error: unknown) {
			logger.error(error);
			return c.json(
				{
					message: "Token exchange failed",
					error: error instanceof Error ? error.message : "Unknown error",
				},
				500,
			);
		}
	},
);

/**
 * Google OAuth redirect callback
 */
app.get(
	"/oauth/callback",
	sValidator(
		"query",
		object({
			code: message(string(), "OAuth2 code is required"),
		}),
	),
	async (c) => {
		const query = c.req.valid("query");
		const authCode = query.code;

		if (!authCode) {
			return c.json({ message: "❌ No OAuth2 code found in request" }, 400);
		}

		logger.log(`🔑 OAuth2 code received`);
		await c.env.drive_kv.put("g_auth_code", authCode);

		return c.json(
			{
				message: "✅ OAuth2 code stored. You can close this tab.",
				google_auth_code: authCode,
			},
			200,
		);
	},
);

/**
 * Generates Google OAuth consent URL
 */
app.post(
	"/oauth/url",
	sValidator(
		"json",
		object({
			client_id: message(
				pipe(string(), trim(), nonEmpty("Client ID shouldn't be empty")),
				"Client ID is required",
			),
			client_secret: message(
				pipe(string(), trim(), nonEmpty("Client Secret shouldn't be empty")),
				"Client Secret is required",
			),
			redirect_uris: message(
				pipe(
					array(pipe(string(), trim())),
					nonEmpty("Redirect URIs shouldn't be empty"),
				),
				"Redirect URIs must be an array of strings",
			),
		}),
	),
	async (c) => {
		const secrets = (await c.req.valid("json")) as OAuthSecrets["web"];

		const authUrl = generateAuthUrl(secrets);

		if (!authUrl) {
			logger.error("❌ Failed to generate OAuth2 URL");
			return c.json({ message: "Failed to generate OAuth2 URL" }, 500);
		}

		logger.log("✅ OAuth2 URL generated & stored");

		return c.json(
			{
				auth_url: authUrl,
				message: "🔗 Use this URL to authorize the application",
			},
			200,
		);
	},
);

/* -------------------------------------------------------------------------- */
/*                                  Root & Health                             */
/* -------------------------------------------------------------------------- */

app.get("/", (c) => {
	return c.json(
		{ status: "Welcome to Drive Webhook", timestamp: Date.now() },
		200,
	);
});

app.get("/health", (c) => {
	return c.json({ status: "OK", timestamp: Date.now() }, 200);
});

export default app;
