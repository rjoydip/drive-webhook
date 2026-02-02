import type { KVNamespace } from "@cloudflare/workers-types";

/* -------------------------------------------------------------------------- */
/*                               Cloudflare KV Types                          */
/* -------------------------------------------------------------------------- */

export interface KVNamespaceInfo {
	id: string;
	title: string;
	supports_url_encoding: boolean;
}

/* -------------------------------------------------------------------------- */
/*                               OAuth / Google Auth Types                    */
/* -------------------------------------------------------------------------- */

/**
 * OAuth token response from Google
 */
export interface OAuthToken {
	/** Access token used for Google API calls */
	access_token?: string | null;

	/** Refresh token (only when access_type=offline) */
	refresh_token?: string | null;

	/** Expiry time in milliseconds since epoch */
	expiry_date?: number | null;

	/** Token type (usually "Bearer") */
	token_type?: string | null;

	/** OpenID Connect ID token (JWT) */
	id_token?: string | null;

	/** Space-delimited list of granted scopes */
	scope?: string;
}

/**
 * OAuth client secrets format (Google-style)
 */
export interface OAuthSecrets {
	web: {
		client_id: string;
		client_secret: string;
		redirect_uris: string[];
	};
}

/* -------------------------------------------------------------------------- */
/*                               Cloudflare Worker Bindings                   */
/* -------------------------------------------------------------------------- */

export type AppBindings = {
	/** Cloudflare KV Namespace for storing Drive tokens & data */
	drive_kv: KVNamespace;
	/** App-specific config */
	WEBHOOK_AUTH_KEY: string;
	CLOUDFLARE_API_TOKEN: string;
};

export type WatchChannel = {
	startPageToken: string;
	accessToken: string;
	channelId: string;
	webhookUrl: string;
	expiration: number;
	webhookToken: string;
};
