import { google } from "googleapis";
import { web } from "../client_secret.json";
import type { Bindings, OAuthSecrets, OAuthToken } from "./types";
import { logger } from "./utils";

/* -------------------------------------------------------------------------- */
/*                               Small Utilities                              */
/* -------------------------------------------------------------------------- */

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getOrUpdateKV(
	kv: Bindings,
	key: string,
	value?: string | null,
): Promise<string | null> {
	if (value) {
		await kv.drive_kv.put(key, value);
		return value;
	}
	return await kv.drive_kv.get(key);
}

/* -------------------------------------------------------------------------- */
/*                           OAuth Client & Auth URL                          */
/* -------------------------------------------------------------------------- */

type OAuthOptions = OAuthSecrets["web"];

function resolveOAuthOptions(options?: OAuthOptions): OAuthOptions {
	return options ?? web;
}

export function getOAuth2Client(options?: OAuthOptions) {
	const { client_id, client_secret, redirect_uris } =
		resolveOAuthOptions(options);

	return new google.auth.OAuth2({
		client_id,
		client_secret,
		redirect_uris,
		forceRefreshOnFailure: true,
	});
}

export function generateAuthUrl(options?: OAuthOptions): string {
	const oauth2Client = getOAuth2Client(options);

	return oauth2Client.generateAuthUrl({
		access_type: "offline", // required for refresh token
		prompt: "consent", // forces refresh token
		scope: ["https://www.googleapis.com/auth/drive"],
	});
}

/* -------------------------------------------------------------------------- */
/*                         OAuth Token Exchange & Refresh                     */
/* -------------------------------------------------------------------------- */

export async function getAccessTokens(
	authCode?: string,
	options?: OAuthOptions,
): Promise<OAuthToken> {
	const oauth2Client = getOAuth2Client(options);
	const code = authCode ?? Bun.env.GOOGLE_AUTH_CODE;

	if (!code) {
		throw new Error("❌ No authorization code provided");
	}

	const { tokens } = await oauth2Client.getToken(code);
	oauth2Client.setCredentials(tokens);

	return tokens;
}

async function refreshAccessToken(env: Bindings) {
	const refreshToken = await env.drive_kv.get("refreshToken");
	const clientId = await env.drive_kv.get("google_client_id");
	const clientSecret = await env.drive_kv.get("google_client_secret");

	if (!refreshToken) {
		throw new Error("❌ No refresh token available");
	}

	if (!clientId) {
		throw new Error("❌ No client ID available");
	}

	if (!clientSecret) {
		throw new Error("❌ No client secret available");
	}

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		throw new Error("❌ Failed to refresh access token");
	}

	return response.json() as Promise<{
		access_token: string;
		expires_in: number;
	}>;
}

/* -------------------------------------------------------------------------- */
/*                     Race-Safe Access Token Retrieval                       */
/* -------------------------------------------------------------------------- */

const LOCK_KEY = "accessTokenRefreshLock";
const LOCK_TTL_MS = 30_000;
const EARLY_REFRESH_MS = 60_000;

export async function getValidAccessToken(env: Bindings): Promise<string> {
	const token = await env.drive_kv.get("accessToken");
	const expiry = Number((await env.drive_kv.get("accessTokenExpiry")) ?? 0);

	// Token still valid
	if (token && Date.now() < expiry - EARLY_REFRESH_MS) {
		return token;
	}

	const now = Date.now();
	const lockTimestamp = await env.drive_kv.get(LOCK_KEY);

	// Another request is already refreshing
	if (lockTimestamp && now - Number(lockTimestamp) < LOCK_TTL_MS) {
		logger.log("⏳ Token refresh in progress, waiting...");
		await sleep(800);
		return getValidAccessToken(env);
	}

	// Acquire refresh lock
	await env.drive_kv.put(LOCK_KEY, now.toString(), {
		expirationTtl: LOCK_TTL_MS / 1000,
	});

	try {
		logger.log("🔄 Refreshing access token...");

		const refreshed = await refreshAccessToken(env);

		await env.drive_kv.put("accessToken", refreshed.access_token);
		await env.drive_kv.put(
			"accessTokenExpiry",
			(Date.now() + refreshed.expires_in * 1000).toString(),
		);

		logger.log("✅ Access token refreshed");
		return refreshed.access_token;
	} finally {
		await env.drive_kv.delete(LOCK_KEY);
	}
}

/* -------------------------------------------------------------------------- */
/*                        Google Drive Webhook Validation                     */
/* -------------------------------------------------------------------------- */

export async function validateDriveWebhook(
	expectedToken?: string | null,
	receivedToken?: string,
): Promise<boolean> {
	if (!receivedToken || receivedToken !== expectedToken) {
		logger.error("🚨 Invalid webhook token");
		return false;
	}

	return true;
}

/* -------------------------------------------------------------------------- */
/*                         Google Drive Change Processing                     */
/* -------------------------------------------------------------------------- */

interface DriveChange {
	changes?: Array<{
		file?: {
			id: string;
			name: string;
			parents?: string[];
		};
	}>;
	newStartPageToken?: string;
}

export async function fetchAndLogChanges(
	env: Bindings,
	accessToken: string,
	googleDriveFolderID: string,
	googleDriveStartPageToken?: string,
): Promise<DriveChange | string> {
	const startPageToken =
		googleDriveStartPageToken ??
		(await env.drive_kv.get("google_drive_start_page_token"));

	if (!startPageToken) {
		logger.warn("⚠️ Google Drive Start Page Token is missing in KV");
		return "No startPageToken";
	}

	const response = await fetch(
		`https://www.googleapis.com/drive/v3/changes?pageToken=${startPageToken}&fields=changes(file(id,name,parents)),newStartPageToken`,
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		},
	);

	if (!response.ok) {
		logger.error("❌ Drive API error", await response.text());
		return "Drive API error";
	}

	const data = (await response.json()) as DriveChange;

	for (const change of data.changes ?? []) {
		const file = change.file;
		if (!file) continue;

		if (file.parents?.includes(googleDriveFolderID)) {
			logger.log("✅ File uploaded:", file.name, file.id);
		}
	}

	if (data.newStartPageToken) {
		await env.drive_kv.put(
			"google_drive_start_page_token",
			data.newStartPageToken,
		);
	}

	return data;
}
