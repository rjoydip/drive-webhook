import { env } from "node:process";
import type { ScheduledController } from "@cloudflare/workers-types";
import { sValidator } from "@hono/standard-validator";
import { type ExecutionContext, Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cache } from "hono/cache";
import { except } from "hono/combine";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import {
	array,
	message,
	nonEmpty,
	object,
	optional,
	pipe,
	string,
	trim,
} from "valibot";
import {
	fetchAndLogChanges,
	generateAuthUrl,
	getAccessTokens,
	getOrUpdateKV,
	getValidAccessToken,
	renewDriveWatchIfNeeded,
	validateDriveWebhook,
	watchChannel,
} from "./helper";
import { rateLimit } from "./middleware";
import type { AppBindings, OAuthSecrets } from "./types";
import { logger } from "./utils";

const app = new Hono<{ Bindings: AppBindings }>();

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
			verifyToken: (token, c) => token === c.env.WEBHOOK_AUTH_KEY,
		}),
	),
);

/* -------------------------------------------------------------------------- */
/*                               Wrangler Tail                                */
/* -------------------------------------------------------------------------- */

// Wrangler Tail
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

// Drive Webhook
app.post(
	"/drive/webhook",
	sValidator(
		"json",
		object({
			drive_folder_id: message(
				pipe(string(), trim()),
				"Google Drive Folder ID is required",
			),
			access_token: optional(pipe(string(), trim())),
			drive_start_page_token: optional(pipe(string(), trim())),
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
				"drive_folder_id",
				c.req.valid("json").drive_folder_id,
			);

			const googleDriveStartPageToken = await getOrUpdateKV(
				c.env,
				"drive_start_page_token",
				c.req.valid("json").drive_start_page_token,
			);

			const accessToken = await getOrUpdateKV(
				c.env,
				"accessToken",
				c.req.valid("json").access_token,
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

// Drive Watch
app.post(
	"/drive/watch",
	sValidator(
		"json",
		object({
			access_token: optional(pipe(string(), trim())),
			drive_start_page_token: optional(pipe(string(), trim())),
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
			const webhookUrl = await getOrUpdateKV(
				c.env,
				"worker_drive_webhook_url",
				body.worker_drive_webhook_url,
			);

			if (
				env.ENVIRONMENT &&
				env.ENVIRONMENT !== "development" &&
				webhookUrl?.startsWith("http://")
			) {
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
				"drive_start_page_token",
				body.drive_start_page_token,
			);

			if (!webhookUrl || !startPageToken) {
				return c.json(
					{ message: "Missing webhook URL or start page token" },
					400,
				);
			}

			// 2️⃣ Generate expiration (24 hours)
			const EXPIRATION_MS = 24 * 60 * 60 * 1000;
			const expiration = Date.now() + EXPIRATION_MS;

			// 3️⃣ Get valid access token
			let accessToken =
				c.req.valid("json").access_token ||
				(await getValidAccessToken(c.env)) ||
				(await c.env.drive_kv.get("accessToken"));

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
			const res = await watchChannel({
				accessToken,
				channelId,
				expiration,
				startPageToken,
				webhookToken,
				webhookUrl,
			});

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

// Dtive Start Page Token
app.post(
	"/drive/startPageToken",
	sValidator(
		"json",
		object({
			access_token: message(pipe(string(), trim()), "Access token is required"),
		}),
	),
	async (c) => {
		const accessToken = await getOrUpdateKV(
			c.env,
			"accessToken",
			c.req.valid("json").access_token,
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
		await c.env.drive_kv.put("drive_start_page_token", startPageToken);

		logger.log(`✅ startPageToken stored: ${startPageToken}`);

		// 4️⃣ Respond
		return c.json(
			{
				message: "Drive change tracking initialized",
				drive_start_page_token: startPageToken,
			},
			200,
		);
	},
);

// Drive Download
app.post(
	"/drive/download",
	sValidator(
		"json",
		object({
			access_token: optional(pipe(string(), trim())),
			file_name: message(pipe(string(), trim()), "File name is required"),
			drive_start_page_token: optional(pipe(string(), trim())),
		}),
	),
	async (c) => {
		try {
			const { file_name } = c.req.valid("json");
			const access_token =
				c.req.valid("json").access_token || (await getValidAccessToken(c.env));
			const drive_start_page_token = await getOrUpdateKV(
				c.env,
				"drive_start_page_token",
				c.req.valid("json").drive_start_page_token,
			);

			if (!access_token) {
				return c.json({ message: "Access Token not found" }, 500);
			}

			if (!drive_start_page_token) {
				return c.json({ message: "Drive start page token not found" }, 500);
			}

			// Fetch changes
			const changesRes = await fetch(
				`https://www.googleapis.com/drive/v3/changes?pageToken=${drive_start_page_token}&fields=changes(file(id,name,mimeType))`,
				{
					headers: { Authorization: `Bearer ${access_token}` },
				},
			);

			if (!changesRes.ok) {
				return c.json({ message: "Failed to fetch changes" }, 500);
			}

			const { changes } = await changesRes.json();

			const targetFile = changes?.find(
				(change: any) => change.file?.name === file_name,
			)?.file;

			if (!targetFile) {
				return c.json({ message: "File not found in recent changes" }, 404);
			}

			// Download file
			const fileRes = await fetch(
				`https://www.googleapis.com/drive/v3/files/${targetFile.id}?alt=media`,
				{
					headers: { Authorization: `Bearer ${access_token}` },
				},
			);

			if (!fileRes.ok) {
				return c.json({ message: "Failed to download file" }, 500);
			}

			const fileBlob = await fileRes.blob();

			return new Response(fileBlob, {
				headers: {
					"Content-Type": targetFile.mimeType || "application/octet-stream",
					"Content-Disposition": `attachment; filename="${targetFile.name}"`,
				},
			});
		} catch (error: unknown) {
			logger.error(error);
			return c.json(
				{
					message: "Download failed",
					error: error instanceof Error ? error.message : "Unknown error",
				},
				500,
			);
		}
	},
);

/* -------------------------------------------------------------------------- */
/*                               OAuth Handlers                                */
/* -------------------------------------------------------------------------- */

// Exchange Google OAuth code for tokens
app.post(
	"/oauth/exchange",
	sValidator(
		"json",
		object({
			auth_code: optional(
				pipe(string(), trim()),
				"Google OAuth2 code is required",
			),
			client_id: optional(
				pipe(string(), trim()),
				"Google Client ID is required",
			),
			client_secret: optional(
				pipe(string(), trim()),
				"Google Client Secret is required",
			),
			redirect_uris: optional(pipe(array(pipe(string(), trim())))),
		}),
	),
	async (c) => {
		const bodyData = c.req.valid("json");

		// Prioritize request body params, fallback to KV
		const client_id = await getOrUpdateKV(
			c.env,
			"client_id",
			bodyData.client_id,
		);
		const client_secret = await getOrUpdateKV(
			c.env,
			"client_secret",
			bodyData.client_secret,
		);
		const redirect_uris =
			bodyData.redirect_uris || (await c.env.drive_kv.get("redirect_uris"));
		const auth_code = await getOrUpdateKV(
			c.env,
			"auth_code",
			bodyData.auth_code,
		);

		if (!auth_code) {
			logger.error("❌ Missing Google OAuth code");
			return c.json({ message: "Missing Google OAuth code" }, 400);
		}

		if (!client_id) {
			throw new Error("🚨 No client ID available");
		}

		if (!client_secret) {
			throw new Error("🚨 No client secret available");
		}

		try {
			// Parse redirect_uris if it's a string from KV
			const parsedRedirectUris =
				typeof redirect_uris === "string"
					? JSON.parse(redirect_uris)
					: redirect_uris;

			const token = await getAccessTokens(
				{
					client_id,
					client_secret,
					redirect_uris: parsedRedirectUris,
				},
				auth_code,
			);

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

// Google OAuth redirect callback
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
		const gAuthCode = query.code;

		if (!gAuthCode) {
			return c.json({ message: "❌ No OAuth2 code found in request" }, 400);
		}

		logger.log(`🔑 OAuth2 code received`);
		await c.env.drive_kv.put("auth_code", gAuthCode);

		return c.json(
			{
				message: "✅ Google OAuth2 code stored. You can close this tab.",
				auth_code: gAuthCode,
			},
			200,
		);
	},
);

// Generates/Register Google OAuth consent URL
app.post(
	"/oauth/url",
	sValidator(
		"json",
		object({
			client_id: message(
				pipe(string(), trim(), nonEmpty("Google Client ID shouldn't be empty")),
				"Client ID is required",
			),
			client_secret: message(
				pipe(
					string(),
					trim(),
					nonEmpty("Google Client Secret shouldn't be empty"),
				),
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

		logger.log("✅ OAuth2 URL generated");

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

// Define the scheduled function
async function scheduled(
	controller: ScheduledController,
	env: AppBindings,
	ctx: ExecutionContext,
): Promise<void> {
	// This code runs when the cron trigger fires
	logger.log(
		`[Cron Trigger]: Job triggered by schedule: ${controller.cron} & ${controller.scheduledTime}`,
	);

	// You can access environment variables here
	logger.log("Accessing secret in cron handler:", env.CLOUDFLARE_API_TOKEN);

	await ctx.waitUntil(renewDriveWatchIfNeeded(env));
}

export default {
	fetch: app.fetch, // Hono handles all incoming HTTP requests
	scheduled, // This handles cron events
};
