# 📁 Google Drive Webhook Worker

A Cloudflare Worker built with **Hono** that integrates with **Google Drive Change Notifications**, supports **OAuth2**, **secure webhooks**, **rate limiting**, **KV persistence**, and **real-time logging**.

This README intentionally contains **both**:

* ✅ **Modern API‑first documentation** (current, recommended)
* 🛠️ **Manual / step‑by‑step setup & process flow** (legacy but still useful for debugging & understanding internals)

---

## 🚀 Features

* Google Drive **Change Notifications (watch API)**
* Secure **Webhook validation** (`X-Goog-Channel-Token`)
* OAuth2 **token exchange & refresh**
* Cloudflare **KV-based persistence**
* Built-in **rate limiting**
* **Bearer token authentication**
* CSRF & Secure Headers
* Realtime **Wrangler log streaming**
* Fully typed & validated inputs (Valibot)

---

## 🧱 Tech Stack

* **Runtime:** Cloudflare Workers
* **Framework:** Hono
* **Validation:** `@hono/standard-validator` + Valibot
* **Storage:** Cloudflare KV
* **Auth:** Google OAuth2 + Bearer Auth
* **Security:** CSRF, Secure Headers
* **Rate Limit:** Custom middleware

---

## 🔐 Environment Variables

| Variable                  | Description                       |
| ------------------------- | --------------------------------- |
| `WEBHOOK_AUTH_CLIENT_KEY` | Bearer token for protected APIs   |
| `CLOUDFLARE_API_TOKEN`    | Token with `Logs:Read` permission |
| `drive_kv`                | Cloudflare KV namespace           |

---

## 📦 KV Keys Used

| Key                             | Purpose                     |
| ------------------------------- | --------------------------- |
| `accessToken`                   | Google OAuth access token   |
| `refreshToken`                  | Google OAuth refresh token  |
| `accessTokenExpiry`             | Token expiry timestamp      |
| `google_drive_start_page_token` | Drive change tracking token |
| `google_drive_folder_id`        | Folder being tracked        |
| `worker_drive_webhook_url`      | Webhook endpoint            |
| `driveWebhookToken`             | Webhook validation token    |
| `driveChannelId`                | Drive watch channel ID      |
| `driveResourceId`               | Drive resource ID           |
| `driveChannelExpiration`        | Channel expiry time         |

---

## 🔑 Authentication

Bearer authentication is required for **all routes except**:

* `/`
* `/health`
* `/oauth/callback`
* `/drive/webhook`

```http
Authorization: Bearer <WEBHOOK_AUTH_CLIENT_KEY>
```

---

## ⚡ Rate Limiting

| Route          | Limit      |
| -------------- | ---------- |
| `/`, `/health` | 60 req/min |
| `/drive/*`     | 5 req/min  |
| Others         | No limit   |

---

## 📡 API Documentation (Primary / Recommended)

### 🟢 Root

#### `GET /`

Returns service status.

```json
{
  "status": "Welcome to Drive Webhook",
  "timestamp": 1700000000000
}
```

---

### 🩺 Health Check

#### `GET /health`

```json
{
  "status": "OK",
  "timestamp": 1700000000000
}
```

---

### 🔍 Logging

#### 📺 Realtime Wrangler Logs

##### `GET /wrangler/tail`

Streams Cloudflare Worker logs in real time.

**Requires:** `CLOUDFLARE_API_TOKEN` with `Logs:Read`

Content-Type: `text/event-stream`

---

### 🔐 OAuth APIs

#### 🔗 Generate Google OAuth URL

##### `POST /oauth/url`

```json
{
  "client_id": "string",
  "client_secret": "string",
  "redirect_uris": ["string"]
}
```

```json
{
  "auth_url": "https://accounts.google.com/o/oauth2/...",
  "message": "🔗 Use this URL to authorize the application"
}
```

---

### 🔁 OAuth Callback

#### `GET /oauth/callback`

Query Params:

| Name   | Type   |
| ------ | ------ |
| `code` | string |

```json
{
  "message": "✅ OAuth2 code stored. You can close this tab.",
  "google_auth_code": "string"
}
```

---

### 🔄 Exchange OAuth Code

#### `POST /oauth/exchange`

```json
{
  "google_auth_code": "string"
}
```

```json
{
  "message": "Token exchange successful",
  "accessToken": "string",
  "refreshToken": "string",
  "expiry_date": 1700000000000
}
```

---

## 📂 Google Drive APIs

### 🚀 Initialize Change Tracking

#### `POST /drive/startPageToken`

```json
{
  "google_access_token": "string"
}
```

```json
{
  "message": "Drive change tracking initialized",
  "google_drive_start_page_token": "string"
}
```

---

### 👀 Create Watch Channel

#### `POST /drive/watch`

```json
{
  "google_access_token": "string",
  "google_drive_start_page_token": "string",
  "worker_drive_webhook_url": "https://example.com/drive/webhook"
}
```

```json
{
  "message": "Drive watch channel created",
  "channelId": "uuid",
  "resourceId": "string",
  "expiration": 1700000000000,
  "webhookToken": "uuid"
}
```

⚠️ HTTPS webhook URLs only

---

### 📩 Drive Webhook Receiver

#### `POST /drive/webhook`

Headers:

| Header                  | Purpose            |
| ----------------------- | ------------------ |
| `X-Goog-Resource-State` | Event type         |
| `X-Goog-Channel-Token`  | Webhook validation |

```json
{
  "google_drive_folder_id": "string",
  "google_access_token": "string",
  "google_drive_start_page_token": "string"
}
```

Behavior:

* Ignores `sync` events
* Validates webhook authenticity
* Fetches & logs Drive changes
* Updates KV automatically

---

## 🛠️ Manual Setup & Process Flow (Legacy / Reference)

> Useful for understanding internals, debugging, or manual recovery.

## High‑Level Architecture

```txt
Google Drive (Folder)
    │
    │  Push Notification (changes.watch)
    ▼
Cloudflare Worker (/drive/webhook)
    │
    │  Fetch Drive Changes API
    ▼
Application Logic / Logs
```

---

## Prerequisites

* Google Account
* Cloudflare Account
* Bun (recommended) or Node.js
* Google Cloud project with **Drive API enabled**

---

## Manual OAuth Flow (One‑Time)

### 1️⃣ Generate OAuth URL

```bash
bun run getAuthURL
```

Complete the consent flow and copy the `code` from the redirect URL.

---

### 2️⃣ Exchange OAuth Code

```bash
bun run genToken
```

Store the returned `access_token` if needed for testing.

⚠️ Access tokens expire — production uses refresh tokens automatically.

---

## Cloudflare KV Setup

### Create KV Namespace

```bash
bunx wrangler kv namespace create drive_kv
```

### Add Secrets

```bash
bunx wrangler secret put WEBHOOK_AUTH_CLIENT_KEY
bunx wrangler secret put CLOUDFLARE_API_TOKEN
```

---

## Deploy Worker

```bash
bunx wrangler deploy
```

Webhook URL:

```txt
https://<worker>.<subdomain>.workers.dev/drive/webhook
```

---

## Manual Drive Watch Creation (Low‑Level)

### Generate Expiration Timestamp (24h)

```bash
echo $(($(date +%s) * 1000 + 86400000))
```

### Create Watch Channel

```bash
curl -X POST \
  "https://www.googleapis.com/drive/v3/changes/watch?pageToken=<token>" \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "drive-watch-001",
    "type": "web_hook",
    "address": "https://<worker>.workers.dev/drive/webhook",
    "expiration": EXPIRATION_TIMESTAMP
  }'
```

---

## Observability

```bash
bunx wrangler tail
```

Expected logs:

```log
📩 Drive change notification received
```

---

## 🛡️ Security Notes

* Webhooks validated via `X-Goog-Channel-Token`
* Token refresh is race‑safe using KV
* Watch channels must be renewed before expiry
* Always persist latest `startPageToken`

---

## 🏁 Deployment

```bash
wrangler deploy
```

Ensure:

* KV namespace bound
* Secrets configured
* OAuth credentials valid

---

## 👥 Contributing

1. Fork the repo
2. Create a feature branch
3. Commit changes
4. Open a PR

---

## 📜 License

MIT © [@rjoydip](https://github.com/rjoydip)
