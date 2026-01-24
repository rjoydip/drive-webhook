# Google Drive Folder Watcher

This project listens for Google Drive folder changes using the Drive Changes API and push notifications, then processes those changes inside a **Cloudflare Worker**.

## Prerequisites

* Google Account
* Cloudflare Account
* Bun (recommended) or Node.js
* Google Cloud project with Drive API enabled

## High-Level Architecture

```txt
Google Drive (Folder)
    │
    │  Push Notification (changes.watch)
    ▼
Cloudflare Worker (/webhook)
    │
    │  Fetch Drive Changes API
    ▼
console.log("File uploaded:", file.name)
```

## Manual Process

### 1. Cloudflare Worker Setup (Webhook)

#### Generate Google OAuth URL

```bash
bun run getAuthURL
```

* Complete the OAuth flow in your browser
* Copy the code from the redirect callback URL
* Add it to `.env`:

```bash
GOOGLE_AUTH_CODE=your_oauth_code_here
```

#### Generate Access Token

```bash
bun run genToken
```

* Copy the `access_token` from console output
* Add it to `.env`:

⚠️ Google access tokens expire. You must regenerate and update this periodically.

### 2. Cloudflare KV Setup

#### Create KV Namespace (One-Time)

```bash
bunx wrangler kv namespace create drive_kv
```

### Add Worker Secrets

```bash
bunx wrangler secret put WRANGLER_API_KEY
bunx wrangler secret put DRIVE_WEBHOOK_URL
bunx wrangler secret put DRIVE_WEBHOOK_CLIENT_KEY
# OR
bunx wrangler secret bulk secrets.json
```

```bash
# secrets.json
{
  "DRIVE_WEBHOOK_CLIENT_KEY": "admin_drive_webhook",
  "WRANGLER_API_KEY": "your_wrangler_api_key_here",
  "DRIVE_WEBHOOK_URL": "https://drive-webhook.<your-subdomain>.workers.dev"
}
```

### Add Values in KV

```bash
bunx wrangler kv key put google_client_id "xxxxx" --namespace-id <NAMESPACE_ID>
bunx wrangler kv key put google_client_secret "xxxxx" --namespace-id <NAMESPACE_ID>
bunx wrangler kv key put google_redirect_uris '["xxxxx"]' --namespace-id <NAMESPACE_ID>
bunx wrangler kv key put google_project_id "xxxxx" --namespace-id <NAMESPACE_ID>
bunx wrangler kv key put folder_id "xxxxx" --namespace-id <NAMESPACE_ID>
```

* `FOLDER_ID` → the Google Drive folder you want to monitor (one-time)

### 3. Deploy the Worker

```bash
bun run deploy
# OR
bunx wrangler deploy
```

Save your webhook URL: `https://drive-webhook.<your-subdomain>.workers.dev/webhook/drive`

### 4. Initialize Google Drive Changes Tracking

#### Step 4.1: Get `startPageToken`

```bash
curl -X GET \
  "https://www.googleapis.com/drive/v3/changes/startPageToken" \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

Response:

```json
{
  "startPageToken": "123456"
}
```

#### Step 4.2: Store Token in KV

```bash
bunx wrangler kv key put pageToken "123456" --namespace-id <NAMESPACE_ID>
```

Or (recommended for production):

```bash
bunx wrangler kv key put pageToken "123456" --namespace-id <NAMESPACE_ID> --remote
```

#### Find Your Namespace ID

```bash
bunx wrangler kv namespace list
```

Example output:

```json
[{ "title": "drive_kv", "id": "a1b2c3d4e5f6" }]
```

### 5. Create Watch Channel (Critical Step)

#### Step 5.1: Generate Expiration Timestamp

Google requires a near-future TTL (max ~7 days)

* **Linux / macOS (24 hours)**

```bash
echo $(($(date +%s) * 1000 + 86400000))
```

* **Windows PowerShell**

```powershell
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 86400000
```

#### Step 5.2: Create a Watch Channel

```bash
curl -X POST \
  "https://www.googleapis.com/drive/v3/changes/watch?pageToken=<pageToken>" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "drive-folder-watch-001",
    "type": "web_hook",
    "address": "https://drive-webhook.<your-subdomain>.workers.dev/webhook/drive",
    "expiration": EXPIRATION_TIMESTAMP
  }'
```

✅ If successful → push notifications are active.

### 6. Test the Flow (Moment of Truth)

#### Step 6.1: Upload a File

Upload a file into your target Drive folder `webhook-test-folder`

#### Step 6.2: Watch Logs

```bash
bunx wrangler tail
```

Expected output:

```log
Connected to drive-webhook, waiting for logs...
POST https://drive-webhook.<your-subdomain>.workers.dev/ - Ok
(log) 📩 Drive change notification received
(log) ✅ File uploaded: example.pdf
```

---

## API way

### Final Hardened Architecture

```txt
Google OAuth (one-time)
        ↓
KV: accessToken / refreshToken / expiry
        ↓
POST /drive/init   → store pageToken
        ↓
POST /drive/watch  → create webhook channel
        ↓
Google Drive → /drive-webhook
        ↓
Webhook token validation
        ↓
Race-safe token refresh
        ↓
Fetch & process changes
```

Use `x-admin-drive-webhook-key` header for authenticate API calls

### 1. OAuth Setup (One-Time)

OAuth is handled entirely via Hono endpoints.

#### Start OAuth Flow

```bash
GET /oauth/url
```

* Redirects to Google consent screen
* Approve access

#### OAuth Callback

Google redirects to:

```txt
/oauth2callback?code=...
```

This endpoint:

* Exchanges code for tokens
* Stores `accessToken`, `refreshToken`, and expiry in KV

✅ OAuth setup is complete.

### 2. Deploy the Worker

```bash
bun run deploy
# or
bunx wrangler deploy
```

Save your webhook URL:

```txt
https://drive-webhook.<your-subdomain>.workers.dev
```

### 3. Initialize Drive Changes Tracking

#### Initialize pageToken

```bash
POST /drive/init
```

What this does:

* Fetches `startPageToken` from Google Drive
* Stores it in KV as `pageToken`

Response:

```json
{
  "message": "Drive change tracking initialized",
  "pageToken": "123456"
}
```

### 4. Create Watch Channel (Critical Step)

#### Create Watch Channel

```bash
POST /drive/watch
```

What this does:

* Reads `pageToken` from KV
* Generates a short-lived expiration (≤ 7 days)
* Creates a Drive watch channel
* Stores channel metadata in KV

Response:

```json
{
  "message": "Drive watch channel created",
  "channelId": "uuid",
  "resourceId": "resource-id",
  "expiration": 1710000000000
}
```

✅ Push notifications are now active.

---

## Local Development

```bash
bun i
```

### Use Generated Bindings with Hono

```typescript
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

## Important Notes

* Webhooks are validated using `X-Goog-Channel-Token`
* Token refresh is race-safe using KV locks
* Watch channels must be renewed before expiration
* Always persist the latest `pageToken`

## ✅ What This Setup Solves

* Fully automated Google Drive change tracking
* Secure webhook validation
* No polling
* Production-ready Cloudflare Worker architecture
