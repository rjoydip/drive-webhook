import { Hono } from "hono";
import { cache } from "hono/cache";
import { csrf } from "hono/csrf";
import { timeout } from "hono/timeout";
import { bearerAuth } from "hono/bearer-auth";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import {
  fetchAndLogChanges,
  generateAuthUrl,
  getAccessTokens,
  getValidAccessToken,
  validateDriveWebhook,
} from "./helper";
import { logger } from "./utils";
import { Bindings, OAuthSecrets } from "./types";
import { rateLimit } from "./middleware";

const app = new Hono<{ Bindings: Bindings }>();

const _rateLimit = rateLimit({
  windowMs: 5 * 60_000,
  max: 3,
});

app.use(csrf());
app.use(prettyJSON());
app.use(secureHeaders());

app.use("/drive/*", timeout(5000));
app.use("/oauth/*", timeout(5000));
app.use("/drive/*", _rateLimit);
app.get(
  "*",
  cache({
    cacheName: "drive-webhook-cache",
    cacheControl: "max-age=3600",
  }),
);
app.use(
  "*",
  bearerAuth({
    verifyToken: async (token, c) => {
      return token === c.env.DRIVE_WEBHOOK_CLIENT_KEY;
    },
  }),
);

/* -------------------------------------------------------------------------- */
/*                               Wrangler Tail                                */
/* -------------------------------------------------------------------------- */

app.get("/wrangler/tail", async (c) => {
  const wranglerResponse = await fetch("https://api.realtime-wrangler.com/tail", {
    headers: {
      Authorization: `Bearer ${c.env.WRANGLER_API_KEY}`,
    },
  });

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
/*                               Drive Webhook                                */
/* -------------------------------------------------------------------------- */

app.post("/drive/watch", async (c) => {
  try {
    logger.log("👀 Creating Drive watch channel");

    // 1️⃣ Read pageToken
    const pageToken = await c.env.drive_kv.get("pageToken");
    if (!pageToken) {
      c.status(400);
      return c.json({ message: "Missing pageToken. Run /drive/init first." });
    }

    // 2️⃣ Generate expiration (24 hours)
    const EXPIRATION_MS = 24 * 60 * 60 * 1000;
    const expiration = Date.now() + EXPIRATION_MS;

    // 3️⃣ Get valid access token
    const accessToken = await getValidAccessToken(c.env);

    // 4️⃣ Generate channel metadata
    const channelId = crypto.randomUUID();
    const webhookToken = crypto.randomUUID(); // used for validation

    // 5️⃣ Create watch channel
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/changes/watch?pageToken=${pageToken}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: channelId,
          type: "web_hook",
          address: c.env.DRIVE_WEBHOOK_URL,
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
    });
  } catch (err: any) {
    logger.error(err);

    c.status(500);
    return c.json({
      message: "Drive watch creation failed",
      error: err.message,
    });
  }
});

app.post("/webhook/drive", async (c) => {
  // 🔐 Validate webhook authenticity
  if (!(await validateDriveWebhook(c, c.env))) {
    logger.error("🚨 Unauthorized Drive webhook call");
    return c.json({ message: "Unauthorized webhook" }, 401);
  }

  const state = c.req.header("X-Goog-Resource-State");

  // Ignore initial sync
  if (state === "sync") {
    logger.log("🔄 Drive sync event received");
    return c.json({ message: "Sync acknowledged", state }, 200);
  }

  logger.log("📩 Drive change notification received");

  const accessToken = await getValidAccessToken(c.env);
  const result = await fetchAndLogChanges(c.env, accessToken);

  return c.json({ message: "Change processed", result }, 200);
});

/* -------------------------------------------------------------------------- */
/*                               OAuth Handlers                                */
/* -------------------------------------------------------------------------- */

app.post("/drive/init", async (c) => {
  try {
    logger.log("🚀 Initializing Drive change tracking");

    // 1️⃣ Get valid access token (refresh-safe)
    const accessToken = await getValidAccessToken(c.env);

    // 2️⃣ Fetch startPageToken from Drive
    const res = await fetch("https://www.googleapis.com/drive/v3/changes/startPageToken", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const error = await res.text();
      logger.error(`❌ Drive API error: ${error}`);

      c.status(500);
      return c.json({
        message: "Failed to fetch startPageToken",
        error,
      });
    }

    const { startPageToken } = await res.json();

    if (!startPageToken) {
      c.status(500);
      return c.json({ message: "startPageToken missing in response" });
    }

    // 3️⃣ Store in KV (remote in prod automatically)
    await c.env.drive_kv.put("pageToken", startPageToken);

    logger.log(`✅ startPageToken stored: ${startPageToken}`);

    // 4️⃣ Respond
    c.status(200);
    return c.json({
      message: "Drive change tracking initialized",
      pageToken: startPageToken,
    });
  } catch (err: any) {
    logger.error(err);

    c.status(500);
    return c.json({
      message: "Drive initialization failed",
      error: err.message,
    });
  }
});

/**
 * Exchange Google OAuth code for tokens
 * (Manual / bootstrap use)
 */
app.get("/oauth/exchange/:g_auth_code", async (c) => {
  const authCode = c.req.param("g_auth_code");

  if (!authCode) {
    logger.error("❌ Missing Google OAuth code");
    return c.json({ message: "Missing Google OAuth code" }, 400);
  }

  try {
    const token = await getAccessTokens(authCode);

    return c.json(
      {
        message: "Token exchange successful",
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiryDate: token.expiry_date,
      },
      200,
    );
  } catch (err: any) {
    logger.error(err);
    return c.json({ message: "Token exchange failed", error: err.message }, 500);
  }
});

/**
 * Persist OAuth tokens to KV
 */
app.post("/oauth/token", async (c) => {
  const body = await c.req.json<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    expiryDate?: number;
  }>();

  if (!body.accessToken) {
    return c.json({ message: "accessToken is required" }, 400);
  }

  const expiry = body.expiryDate ?? Date.now() + (body.expiresIn ?? 3600) * 1000;

  await c.env.drive_kv.put("accessToken", body.accessToken);
  await c.env.drive_kv.put("accessTokenExpiry", expiry.toString());

  if (body.refreshToken) {
    await c.env.drive_kv.put("refreshToken", body.refreshToken);
  }

  logger.log("✅ OAuth tokens stored in KV");

  return c.json({ message: "Tokens stored successfully" }, 200);
});

/**
 * Google OAuth redirect callback
 */
app.get("/oauth/callback", async (c) => {
  const authCode = c.req.query("code");

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
});

/**
 * Generates Google OAuth consent URL
 */
app.post("/oauth/url", async (c) => {
  const secrets = await c.req.json<OAuthSecrets["web"]>();

  const authUrl = generateAuthUrl(secrets);

  if (!authUrl) {
    logger.error("❌ Failed to generate OAuth2 URL");
    return c.json({ message: "Failed to generate OAuth2 URL" }, 500);
  }

  logger.log("✅ OAuth2 URL generated & stored");

  await c.env.drive_kv.put("google_client_id", secrets.client_id ?? "");
  await c.env.drive_kv.put("google_client_secret", secrets.client_secret ?? "");
  await c.env.drive_kv.put("google_redirect_uris", JSON.stringify(secrets.redirect_uris ?? []));
  await c.env.drive_kv.put("google_project_id", secrets.project_id ?? "");

  return c.json(
    {
      auth_url: authUrl,
      message: "🔗 Use this URL to authorize the application",
    },
    200,
  );
});

/* -------------------------------------------------------------------------- */
/*                                   Health                                   */
/* -------------------------------------------------------------------------- */

app.get("/health", () => {
  return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
});

export default app;
