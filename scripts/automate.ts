import { $ } from "bun";
import os from "node:os";
import { parseEnv } from "node:util";
import { join } from "node:path";

import { interactive, textCyan, textGreen, textWhite } from "./_utils";
import { KVNamespaceInfo, OAuthSecrets } from "../src/types";
import { getAccessTokens } from "../src/helper";
import { KV_NS, logger } from "../src/utils";

/* -------------------------------------------------------------------------- */
/*                               KV Utilities                                 */
/* -------------------------------------------------------------------------- */

async function getKVNamespace(): Promise<KVNamespaceInfo | null> {
  const namespaces: KVNamespaceInfo[] = await $`wrangler kv namespace list`.json();

  return namespaces.find((ns) => ns.title === KV_NS) ?? null;
}

async function ensureKVNamespace(): Promise<string> {
  const existing = await getKVNamespace();

  if (existing) {
    interactive.success("[2/10] - Found KV namespace");
    return existing.id;
  }

  interactive.error("[2/10] - KV namespace not found, creating...");
  const created: KVNamespaceInfo[] = await $`wrangler kv namespace create ${KV_NS}`.json();

  return created[0].id;
}

/* -------------------------------------------------------------------------- */
/*                            ENV / Secrets Utils                              */
/* -------------------------------------------------------------------------- */

async function loadEnvVars(envPath: string) {
  const content = await Bun.file(envPath).text();
  return parseEnv(content);
}

function normalizeEnvVars(env: Dict<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value!]),
  );
}

async function loadOAuthSecrets(secretPath: string): Promise<OAuthSecrets> {
  return Bun.file(secretPath).json();
}

async function writeTempEnvFile(envVars: Record<string, string>) {
  const tempDir = os.tmpdir();
  const filename = `tempfile-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}.json`;

  const filePath = join(tempDir, filename);
  const bytes = await Bun.write(filePath, JSON.stringify(envVars, null, 2));

  logger.success(
    `Successfully wrote ${textGreen}${bytes}${textWhite} bytes to ${textCyan}${filename}${textWhite}`,
  );

  return filePath;
}

/* -------------------------------------------------------------------------- */
/*                          Google Drive Utilities                              */
/* -------------------------------------------------------------------------- */

async function getStartPageToken(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/changes/startPageToken", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Drive API error: ${await res.text()}`);
  }

  const data = await res.json();
  return data.startPageToken;
}

/* -------------------------------------------------------------------------- */
/*                                   Main                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const TOTAL_STEPS = 10;
  const ENV_PATH = "./.env";
  const SECRET_PATH = "./client_secret.json";

  interactive.await(`[1/${TOTAL_STEPS}] - List KV namespaces`);

  const namespaceId = await ensureKVNamespace();

  interactive.success(`[3/${TOTAL_STEPS}] - Load ENV & OAuth secrets`);

  const rawEnvVars = await loadEnvVars(ENV_PATH);
  const normalizedEnvVars = normalizeEnvVars(rawEnvVars);

  const {
    web: { client_id, client_secret },
  } = await loadOAuthSecrets(SECRET_PATH);

  interactive.await(`[4/${TOTAL_STEPS}] - Exchange OAuth code for tokens`);

  const { refresh_token, access_token } = await getAccessTokens(normalizedEnvVars.GOOGLE_AUTH_CODE);

  interactive.success(`[5/${TOTAL_STEPS}] - Update ENV values`);

  normalizedEnvVars.GOOGLE_CLIENT_ID = client_id!;
  normalizedEnvVars.GOOGLE_CLIENT_SECRET = client_secret!;

  interactive.await(`[6/${TOTAL_STEPS}] - Create temporary ENV file`);

  if (!refresh_token) {
    throw new Error("Missing refresh token");
  }

  if (!access_token) {
    throw new Error("Missing access token");
  }

  const tempEnvFile = await writeTempEnvFile(normalizedEnvVars);

  interactive.await(`[7/${TOTAL_STEPS}] - Fetch Drive startPageToken`);

  const startPageToken = await getStartPageToken(access_token);
  interactive.success(`[8/${TOTAL_STEPS}] - Start Page Token (${startPageToken})`);

  if (startPageToken) {
    await $`wrangler kv key put pageToken ${startPageToken} --namespace-id ${namespaceId} --remote`;
  }

  interactive.await(`[9/${TOTAL_STEPS}] - Upload secrets to Cloudflare`);

  const bulkResult = await $`wrangler secret bulk ${tempEnvFile} --name ${KV_NS}`.text();

  logger.info(bulkResult);

  interactive.success(`[10/${TOTAL_STEPS}] - Setup completed`);
}

main().catch(logger.error);
