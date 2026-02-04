# 📁 Google Drive Webhook Worker

A Cloudflare Worker built with **Hono** that integrates with **Google Drive Change Notifications**, supports **OAuth2**, **secure webhooks**, **rate limiting**, **KV persistence**, and **real-time logging**.

---

## 📋 Table of Contents

- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Quick Start](#-quick-start)
- [Environment Setup](#-environment-setup)
- [API Documentation](#-api-documentation)
- [Testing](#-testing)
- [Manual Setup Guide](#-manual-setup-guide)
- [Security](#-security)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Features

- Google Drive **Change Notifications (watch API)**
- Secure **Webhook validation** (`X-Goog-Channel-Token`)
- OAuth2 **token exchange & refresh**
- Cloudflare **KV-based persistence**
- Built-in **rate limiting**
- **Bearer token authentication**
- CSRF & Secure Headers
- Realtime **Wrangler log streaming**
- Fully typed & validated inputs (Valibot)
- **Comprehensive test coverage** with Bun.js
- **Complete Postman collection** for API testing

---

## 🧱 Tech Stack

- **Runtime:** Cloudflare Workers
- **Framework:** Hono
- **Validation:** `@hono/standard-validator` + `Valibot`
- **Storage:** Cloudflare KV
- **Auth:** Google OAuth2 + Bearer Auth
- **Security:** CSRF, Secure Headers
- **Rate Limit:** Custom middleware
- **Testing:** Bun Test Runner
- **API Testing:** Postman

---

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (v1.0.0 or higher) or Node.js
- Google Cloud Project with Drive API enabled
- Cloudflare Account
- Google Account

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd drive-webhook-worker

# Install dependencies
bun install

# Run tests
bun test

# Deploy to Cloudflare
bunx wrangler deploy
```

### Quick Setup Flow

1. **Configure Environment** → Set up secrets and KV namespace
2. **OAuth Authentication** → Generate URL, authorize, exchange tokens
3. **Initialize Drive Tracking** → Get start page token
4. **Create Watch Channel** → Set up webhook notifications
5. **Test & Monitor** → Verify webhook reception and logs

---

## 🔧 Environment Setup

### Environment Variables

| Variable                  | Description                       | Required |
| ------------------------- | --------------------------------- | -------- |
| `WEBHOOK_AUTH_KEY` | Bearer token for protected APIs          | ✅       |
| `CLOUDFLARE_API_TOKEN`    | Token with `Logs:Read` permission | ✅       |
| `drive_kv`                | Cloudflare KV namespace           | ✅       |

### KV Keys Used

| Key                             | Purpose                       |
| ------------------------------- | ----------------------------- |
| `accessToken`                   | Google OAuth access token     |
| `refreshToken`                  | Google OAuth refresh token    |
| `accessTokenExpiry`             | Token expiry timestamp        |
| `drive_start_page_token`        | Drive change tracking token   |
| `drive_folder_id`               | Folder being tracked          |
| `client_id`                     | Google Client ID              |
| `client_secret`                 | Google Client Secret          |
| `auth_code`                     | Google Auth Code              |
| `worker_drive_webhook_url`      | Webhook endpoint              |
| `driveWebhookToken`             | Webhook validation token      |
| `driveChannelId`                | Drive watch channel ID        |
| `driveResourceId`               | Drive resource ID             |
| `driveChannelExpiration`        | Channel expiry time           |

### Create KV Namespace

```bash
bunx wrangler kv namespace create drive_kv
```

### Add Secrets

```bash
bunx wrangler secret put WEBHOOK_AUTH_KEY
bunx wrangler secret put CLOUDFLARE_API_TOKEN
```

### Development Environment

Create `.env.local`:

```bash
WEBHOOK_AUTH_KEY=your_dev_key
CLOUDFLARE_API_TOKEN=your_cf_token
```

---

## 🔐 Authentication

Bearer authentication is required for **all routes except**:

- `/`
- `/health`
- `/oauth/callback`
- `/drive/webhook`

```http
Authorization: Bearer <WEBHOOK_AUTH_KEY>
```

---

## ⚡ Rate Limiting

| Route          | Limit      |
| -------------- | ---------- |
| `/`, `/health` | 60 req/min |
| `/drive/*`     | 5 req/min  |
| Others         | No limit   |

---

## 📡 API Documentation

### Architecture Overview

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

### 🟢 Health & Status

#### `GET /`

Returns service status.

**Response:**

```json
{
  "status": "Welcome to Drive Webhook",
  "timestamp": 1700000000000
}
```

#### `GET /health`

Health check endpoint.

**Response:**

```json
{
  "status": "OK",
  "timestamp": 1700000000000
}
```

---

### 🔐 OAuth Endpoints

#### 1. Generate Google OAuth URL

**`POST /oauth/url`**

Creates authorization URL for Google OAuth consent flow.

**Request:**

```json
{
  "client_id": "string",
  "client_secret": "string",
  "redirect_uris": ["string"]
}
```

**Response:**

```json
{
  "auth_url": "https://accounts.google.com/o/oauth2/...",
  "message": "🔗 Use this URL to authorize the application"
}
```

**Usage:**

1. Call this endpoint with your Google OAuth credentials
2. Copy the returned `auth_url`
3. Open URL in browser to authorize
4. You'll be redirected to the callback URL with an auth code

---

#### 2. OAuth Callback

**`GET /oauth/callback`**

Handles Google OAuth redirect and stores authorization code.

**Query Parameters:**

| Name   | Type   | Description        |
| ------ | ------ | ------------------ |
| `code` | string | OAuth2 code from Google |

**Response:**

```json
{
  "message": "✅ OAuth2 code stored. You can close this tab.",
  "auth_code": "string"
}
```

---

#### 3. Exchange OAuth Code for Tokens

**`POST /oauth/exchange`**

Exchanges authorization code for access and refresh tokens.

**Request:**

```json
{
  "auth_code": "string",
  "client_id": "string",
  "client_secret": "string",
  "redirect_uris": "string",
}
```

**Response:**

```json
{
  "message": "Token exchange successful",
  "accessToken": "string",
  "refreshToken": "string",
  "expiry_date": 1700000000000
}
```

**Note:** Tokens are automatically stored in KV for subsequent use.

---

### 📂 Google Drive Endpoints

#### 1. Initialize Change Tracking

**`POST /drive/startPageToken`**

Fetches the start page token required for Drive change tracking.

**Request:**

```json
{
  "access_token": "string"
}
```

**Response:**

```json
{
  "message": "Drive change tracking initialized",
  "drive_start_page_token": "string"
}
```

**Purpose:** This token marks the starting point for tracking changes in Google Drive.

---

#### 2. Create Watch Channel

**`POST /drive/watch`**

Sets up a Google Drive watch channel for receiving change notifications.

**Request:**

```json
{
  "access_token": "string",
  "drive_start_page_token": "string",
  "worker_drive_webhook_url": "https://example.com/drive/webhook"
}
```

**Response:**

```json
{
  "message": "Drive watch channel created",
  "channelId": "uuid",
  "resourceId": "string",
  "expiration": 1700000000000,
  "webhookToken": "uuid"
}
```

**Important:**

- ⚠️ HTTPS webhook URLs only (HTTP URLs are rejected)
- ⏰ Watch channels expire after 24 hours and must be renewed
- 🔑 Save the `webhookToken` for validating incoming notifications

---

#### 3. Drive Webhook Handler

**`POST /drive/webhook`**

Receives and processes Google Drive change notifications.

**Headers:**

| Header                  | Purpose                        |
| ----------------------- | ------------------------------ |
| `X-Goog-Resource-State` | Event type (`sync` or `change`) |
| `X-Goog-Channel-Token`  | Webhook validation token       |
| `X-Goog-Resource-ID`    | Resource identifier from Google |
| `X-Goog-Channel-ID`     | Channel identifier             |

**Request:**

```json
{
  "drive_folder_id": "string",
  "access_token": "string",
  "drive_start_page_token": "string"
}
```

**Behavior:**

1. **Sync Events**: Initial notification when watch is created (acknowledged and ignored)
2. **Change Events**: Actual file/folder changes
   - Validates webhook token
   - Fetches detailed change information from Drive API
   - Updates start page token in KV
   - Logs changes

**Response (Sync):**

```json
{
  "message": "Sync acknowledged",
  "state": "sync"
}
```

**Response (Change):**

```json
{
  "message": "Change processed",
  "result": {
    "changes": []
  }
}
```

**Response (Unauthorized):**

```json
{
  "message": "Unauthorized webhook"
}
```

#### 4. Download Changed File

**`POST /drive/download`**

Downloads a specific file from recent Drive changes.

**Request:**

```json
{
  "access_token": "string",
  "file_name": "document.pdf",
  "drive_start_page_token": "string"
}
```

**Response:**

- Binary file content with appropriate Content-Type
- `Content-Disposition` header with filename

**Status Codes:**

- `200`: File downloaded successfully
- `404`: File not found in recent changes
- `500`: Download failed

---

### 🔍 Monitoring

#### Realtime Wrangler Logs

**`GET /wrangler/tail`**

Streams Cloudflare Worker logs in real-time.

**Requirements:**

- `CLOUDFLARE_API_TOKEN` with `Logs:Read` scope

**Response:**

- Content-Type: `text/event-stream`
- Server-Sent Events stream with real-time log data

**Usage:**

```bash
curl -N https://your-worker.workers.dev/wrangler/tail \
  -H "Authorization: Bearer YOUR_AUTH_KEY"
```

---

## 🧪 Testing

### Unit Tests with Bun.js

The project includes comprehensive unit tests covering all endpoints and functionality.

#### Running Tests

```bash
# Run all tests
bun test

# Run tests with coverage
bun test --coverage

# Run tests in watch mode
bun test --watch

# Run specific test file
bun test app.test.ts

# Run tests with verbose output
bun test --verbose
```

#### Test Coverage

The test suite (`app.test.ts`) includes **30+ test cases** covering:

✅ **Health & Status Endpoints**

- Root endpoint welcome message
- Health check endpoint

✅ **OAuth Flow**

- OAuth URL generation with valid credentials
- Validation of required fields (client_id, client_secret, redirect_uris)
- OAuth callback code storage
- Token exchange flow
- Empty and missing field validation

✅ **Drive Integration**

- Start page token retrieval
- Watch channel creation
- Webhook URL validation (HTTPS enforcement)
- Webhook event processing (sync and change events)
- Webhook authentication validation

✅ **Security**

- Bearer token authentication
- Invalid token rejection
- CSRF protection headers

✅ **Helper Functions**

- KV storage operations
- Key-value retrieval and deletion

#### Test Structure Example

```typescript
describe("Feature Name", () => {
  let mockEnv: AppBindings;

  beforeEach(() => {
    mockEnv = createMockEnv();
    (mockEnv.drive_kv as MockKV).clear();
  });

  test("should perform expected behavior", async () => {
    const req = new Request("http://localhost/endpoint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test_auth_key",
      },
      body: JSON.stringify({ /* payload */ }),
    });

    const res = await app.fetch(req, mockEnv);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.message).toContain("expected text");
  });
});
```

#### Mocking Strategy

The test suite uses Bun's built-in mocking:

```typescript
// Mock external dependencies
const mockHelpers = {
  fetchAndLogChanges: mock(() => Promise.resolve({ changes: [] })),
  generateAuthUrl: mock(() => "https://accounts.google.com/o/oauth2/auth?..."),
  getAccessTokens: mock(() => Promise.resolve({
    access_token: "mock_access_token",
    refresh_token: "mock_refresh_token",
    expiry_date: Date.now() + 3600000,
  })),
};

// Mock KV storage
class MockKV {
  private store = new Map<string, string>();
  
  async get(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }
  
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
```

---

### API Testing with Postman

#### Importing the Collection

1. Open Postman
2. Click **Import** button
3. Select `postman_collection.json`
4. Import `postman_environment.json` for quick variable setup
5. The collection will be imported with all endpoints and variables

#### Collection Variables

Configure these variables before testing:

| Variable | Description | Example |
|----------|-------------|---------|
| `baseUrl` | Your Worker URL | `https://your-worker.workers.dev` |
| `WEBHOOK_AUTH_KEY` | Auth token for API | `your_secret_key` |
| `client_id` | Google OAuth Client ID | `123456.apps.googleusercontent.com` |
| `client_secret` | Google OAuth Client Secret | `GOCSPX-xxxxx` |
| `drive_folder_id` | Target Drive folder ID | `1A2B3C4D5E6F` |
| `worker_drive_webhook_url` | Webhook endpoint URL | `https://your-worker.workers.dev/drive/webhook` |

**Auto-populated variables** (filled by test scripts):

- `auth_code`
- `access_token`
- `refresh_token`
- `drive_start_page_token`

#### Collection Structure

- **📁 Health & Status**

- Root Endpoint: Basic service information
- Health Check: Service health verification

- **📁 OAuth Flow**

1. Generate OAuth URL
2. OAuth Callback (manual)
3. Exchange Auth Code for Tokens

- **📁 Drive Setup**

1. Get Start Page Token
2. Create Watch Channel

- **📁 Webhook Events**

- Drive Webhook Handler

- **📁 Monitoring**

- Wrangler Tail Stream

#### Complete Testing Workflow

```bash
Step 1: Configure collection variables
        ↓
Step 2: Generate OAuth URL → Open in browser
        ↓
Step 3: Authorize application → Get auth code
        ↓
Step 4: Exchange auth code for tokens (auto-saves)
        ↓
Step 5: Get start page token (auto-saves)
        ↓
Step 6: Create watch channel
        ↓
Step 7: Test webhook by making Drive changes
        ↓
Step 8: Monitor logs via Wrangler tail
```

#### Example Requests

**Generate OAuth URL:**

```http
POST {{baseUrl}}/oauth/url
Authorization: Bearer {{WEBHOOK_AUTH_KEY}}
Content-Type: application/json

{
  "client_id": "{{client_id}}",
  "client_secret": "{{client_secret}}",
  "redirect_uris": ["{{baseUrl}}/oauth/callback"]
}
```

**Create Watch Channel:**

```http
POST {{baseUrl}}/drive/watch
Authorization: Bearer {{WEBHOOK_AUTH_KEY}}
Content-Type: application/json

{
  "access_token": "{{access_token}}",
  "drive_start_page_token": "{{drive_start_page_token}}",
  "worker_drive_webhook_url": "{{worker_drive_webhook_url}}"
}
```

#### Automatic Test Scripts

The collection includes scripts that automatically save response data:

```javascript
// After token exchange
if (pm.response.code === 200) {
    const response = pm.response.json();
    pm.collectionVariables.set('access_token', response.accessToken);
    pm.collectionVariables.set('refresh_token', response.refreshToken);
    console.log('✅ Tokens saved to collection variables');
}
```

---

### CI/CD Integration

Example GitHub Actions workflow:

```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      
      - run: bun install
      - run: bun test
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        if: always()
```

---

## 🛠️ Manual Setup Guide

> This section provides detailed step-by-step instructions for manual setup and debugging.

### Manual OAuth Flow

#### 1️⃣ Generate OAuth URL

```bash
bun run getAuthURL
```

Or use the API:

```bash
curl -X POST https://your-worker.workers.dev/oauth/url \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "redirect_uris": ["https://your-worker.workers.dev/oauth/callback"]
  }'
```

Complete the consent flow in your browser and copy the `code` from the redirect URL.

---

#### 2️⃣ Exchange OAuth Code

```bash
bun run genToken
```

Or use the API:

```bash
curl -X POST https://your-worker.workers.dev/oauth/exchange \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "auth_code": "YOUR_AUTH_CODE"
  }'
```

Store the returned tokens for production use.

⚠️ **Note:** Access tokens expire after 1 hour. The worker automatically refreshes them using the stored refresh token.

---

### Manual Drive Watch Creation

#### Generate Expiration Timestamp (24 hours)

```bash
echo $(($(date +%s) * 1000 + 86400000))
```

#### Create Watch Channel (Low-Level)

```bash
curl -X POST \
  "https://www.googleapis.com/drive/v3/changes/watch?pageToken=YOUR_START_PAGE_TOKEN" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "drive-watch-001",
    "type": "web_hook",
    "address": "https://your-worker.workers.dev/drive/webhook",
    "expiration": YOUR_EXPIRATION_TIMESTAMP,
    "token": "YOUR_VALIDATION_TOKEN"
  }'
```

---

### Deployment

```bash
# Deploy to production
bunx wrangler deploy

# Deploy to specific environment
bunx wrangler deploy --env dev
bunx wrangler deploy --env production
```

**Ensure before deployment:**

- ✅ KV namespace is bound in `wrangler.toml`
- ✅ Secrets are configured
- ✅ OAuth credentials are valid
- ✅ Tests are passing

---

### Monitoring & Observability

#### View Real-Time Logs

```bash
bunx wrangler tail
```

Or use the API endpoint:

```bash
curl -N https://your-worker.workers.dev/wrangler/tail \
  -H "Authorization: Bearer YOUR_AUTH_KEY"
```

#### Expected Log Output

```log
🚀 Starting Wrangler log tailing session
🔗 Connecting to Realtime Wrangler API...
📩 Drive change notification received
✅ Drive watch channel created
🔄 Drive sync event received
```

#### Cloudflare Dashboard

Monitor your worker in the Cloudflare dashboard:

- Request counts
- Error rates
- Execution time
- KV operations
- Bandwidth usage

---

## 🛡️ Security

### Security Features

✅ **Webhook Validation**

- All incoming Drive webhooks are validated using `X-Goog-Channel-Token`
- Prevents unauthorized webhook calls

✅ **Token Security**

- Access tokens automatically refreshed before expiry
- Race-safe token refresh using KV atomic operations
- Refresh tokens stored securely in KV

✅ **Authentication**

- Bearer token authentication for all protected endpoints
- CSRF protection enabled
- Secure headers middleware

✅ **HTTPS Enforcement**

- Webhook URLs must use HTTPS
- HTTP URLs are rejected with a 400 error

✅ **Rate Limiting**

- Prevents abuse of sensitive endpoints
- Different limits for different endpoint categories

### Security Best Practices

1. **Rotate Secrets Regularly**

   ```bash
   bunx wrangler secret put WEBHOOK_AUTH_KEY
   ```

2. **Monitor Webhook Calls**
   - Check for unauthorized attempts
   - Review logs for suspicious patterns

3. **Renew Watch Channels**
   - Watch channels expire after 24 hours
   - Set up automated renewal before expiry

4. **Token Management**
   - Never commit OAuth credentials to version control
   - Use Cloudflare secrets for sensitive data
   - Always persist latest `startPageToken` in KV

5. **Access Control**
   - Limit Google OAuth scopes to minimum required
   - Use service accounts for production
   - Review Google Cloud Console audit logs

---

## 🔧 Troubleshooting

### Common Issues

#### 1. Test Failures

**Problem:** Tests are failing after installation

**Solutions:**

```bash
# Clear bun cache
rm -rf node_modules/.cache

# Reinstall dependencies
rm -rf node_modules
bun install

# Run tests with verbose output
bun test --verbose
```

---

#### 2. OAuth Issues

**Problem:** "Invalid OAuth credentials"

**Solutions:**

- Verify `client_id` and `client_secret` are correct
- Ensure redirect URI matches exactly (including trailing slash)
- Check that Google Drive API is enabled in Cloud Console
- Verify OAuth consent screen is configured

**Problem:** "Token expired"

**Solution:**

- Re-run the OAuth flow to get fresh tokens
- The worker should automatically refresh using the refresh token
- Check KV for valid `refreshToken`

---

#### 3. Webhook Issues

**Problem:** Webhook not receiving notifications

**Solutions:**

- Verify watch channel hasn't expired (24-hour limit)
- Check webhook URL is HTTPS
- Ensure webhook endpoint is publicly accessible
- Validate `driveWebhookToken` in KV matches the token from channel creation
- Check Cloudflare logs for incoming requests

**Problem:** "Unauthorized webhook"

**Solutions:**

- Verify `X-Goog-Channel-Token` header matches stored token
- Check KV for `driveWebhookToken` value
- Recreate watch channel if token is missing

---

#### 4. Rate Limiting

**Problem:** "Rate limit exceeded"

**Current Limits:**

- Health endpoints: 60 requests/minute
- Drive endpoints: 5 requests/minute
- Other endpoints: No limit

**Solutions:**

- Implement exponential backoff in client
- Batch operations when possible
- Contact maintainer if limits are too restrictive

---

#### 5. KV Issues

**Problem:** "KV key not found"

**Solutions:**

```bash
# Check KV namespace binding in wrangler.toml
# List all keys
bunx wrangler kv:key list --namespace-id=YOUR_NAMESPACE_ID

# Get specific key value
bunx wrangler kv:key get "accessToken" --namespace-id=YOUR_NAMESPACE_ID
```

---

#### 6. Postman Issues

**Problem:** 401 Unauthorized in Postman

**Solutions:**

- Check `WEBHOOK_AUTH_KEY` collection variable is set
- Ensure Bearer token is in Authorization header
- Verify the token matches your Cloudflare secret

**Problem:** Variables not auto-populating

**Solutions:**

- Check test scripts in the request
- Verify response status is 200
- Open Postman Console (View → Show Postman Console) to see script output

---

#### 7. Deployment Issues

**Problem:** "KV namespace not found"

**Solution:**
Check `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "drive_kv"
id = "your_namespace_id"
```

**Problem:** "Secret not found"

**Solution:**

```bash
# List secrets
bunx wrangler secret list

# Add missing secret
bunx wrangler secret put WEBHOOK_AUTH_KEY
```

---

### Debug Mode

Enable verbose logging:

```bash
# Local development
bunx wrangler dev --log-level debug

# Tail with filter
bunx wrangler tail --status error
```

---

### Getting Help

If you're still experiencing issues:

1. **Check logs** via `wrangler tail` or Cloudflare dashboard
2. **Review environment variables** and KV storage
3. **Verify OAuth tokens** haven't expired
4. **Test with Postman** to isolate the issue
5. **Run unit tests** to ensure code integrity
6. **Check Google Drive API quotas** in Cloud Console
7. **Open an issue** with detailed error messages and logs

---

## 📚 Additional Resources

- [Hono Framework Documentation](https://hono.dev/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Google Drive API Reference](https://developers.google.com/drive/api/reference/rest/v3)
- [Google Drive Push Notifications](https://developers.google.com/drive/api/guides/push)
- [Bun Testing Documentation](https://bun.sh/docs/cli/test)
- [Postman Learning Center](https://learning.postman.com/)
- [Valibot Schema Validation](https://valibot.dev/)

---

## 🎯 Best Practices

### Development Workflow

1. **Local Development**

   ```bash
   bunx wrangler dev
   ```

2. **Run Tests**

   ```bash
   bun test
   ```

3. **Test with Postman**
   - Use the provided collection
   - Test all endpoints
   - Verify webhook flow

4. **Deploy to Development**

   ```bash
   bunx wrangler deploy --env dev
   ```

5. **Monitor & Validate**

    ```bash
    bunx wrangler tail --env dev
    ```

6. **Deploy to Production**

  ```bash
  bunx wrangler deploy --env production
  ```

---

### Unit Testing Best Practices

- ✅ Always clear KV store between tests using `beforeEach`
- ✅ Use descriptive test names that explain the behavior
- ✅ Test both success and failure cases
- ✅ Mock external dependencies (Drive API, OAuth)
- ✅ Verify response structure, not just status codes
- ✅ Test edge cases (empty strings, null values, invalid tokens)

---

### API Testing Best Practices

- ✅ Use environment variables for secrets (never hardcode)
- ✅ Leverage Postman test scripts for automation
- ✅ Save common responses as examples for documentation
- ✅ Test error scenarios (401, 400, 500)
- ✅ Document expected behaviors in request descriptions
- ✅ Use collection variables for dynamic values

---

### Production Considerations

1. **Token Management**
   - Monitor token expiry
   - Implement automatic refresh
   - Log refresh failures

2. **Watch Channel Renewal**
   - Set up cron trigger to renew channels before 24h expiry
   - Implement retry logic for renewal failures

3. **Error Handling**
   - Log all errors with context
   - Implement proper error responses
   - Alert on critical failures

4. **Monitoring**
   - Set up alerts for error rates
   - Monitor KV operation latency
   - Track webhook processing times

5. **Scaling**
   - Monitor rate limits
   - Implement request queuing if needed
   - Consider multiple workers for high traffic

---

## 👥 Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**

    ```bash
    git checkout -b feature/amazing-feature
    ```

3. **Make your changes**
   - Follow existing code style
   - Add tests for new features
   - Update documentation
4. **Run tests**

    ```bash
    bun test
    ```

5. **Commit your changes**

    ```bash
    git commit -m 'Add amazing feature'
    ```

6. **Push to your fork**

    ```bash
    git push origin feature/amazing-feature
    ```

7. **Open a Pull Request**

### Contribution Guidelines

- Write clear commit messages
- Add tests for new features
- Update README if adding new endpoints
- Maintain backward compatibility
- Follow TypeScript best practices
- Ensure all tests pass before submitting PR

---

## 📜 License

MIT © [@rjoydip](https://github.com/rjoydip)

---

## 🙏 Acknowledgments

- **Hono** - Lightning-fast web framework
- **Cloudflare Workers** - Edge computing platform
- **Google Drive API** - File storage and change notifications
- **Bun** - Fast JavaScript runtime and test runner
- **Valibot** - Schema validation library

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/rjoydip/drive-webhook/issues)
- **Discussions**: [GitHub Discussions](https://github.com/rjoydip/drive-webhook/discussions)

---

## 🗺️ Roadmap

- [ ] Add support for multiple Drive folders
- [ ] Implement webhook signature verification
- [ ] Add Slack/Discord notifications
- [ ] Create dashboard for monitoring
- [ ] Add support for Google Docs-specific events
- [ ] Implement automatic channel renewal via cron
- [ ] Add GraphQL API
- [ ] Support for team drives
- [ ] Webhook retry mechanism
- [ ] Analytics and reporting

---

**Built with ❤️ using Cloudflare Workers and Hono**