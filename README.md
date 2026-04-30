<p align="center">
  <img src="assets/logo/carrot-gold-256.png" width="120" alt="Carrot Labs" />
</p>

<h1 align="center">Carrot</h1>

<p align="center">
  <strong>The bridge between AI agents and your browser.</strong><br/>
  Built by <a href="https://carrotlabs.ai">Carrot Labs</a>.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#self-hosting">Self-host</a>
</p>

---

Carrot is a Chrome extension plus a tiny bridge server that lets AI agents safely drive your browser: read accessibility trees, click and type, fill forms, manage tabs, take screenshots, and inspect console and network traffic — all through a simple HTTP and MCP API.

Every agent action streams live into a **side panel** in your browser, and a subtle gold overlay appears on any page being controlled so you always know when an agent is at the wheel.

**Hosted bridge:** `https://browser.carrotlabs.ai`

## Highlights

- **Live side panel** — sleek black/gold UI streaming every agent action in real time
- **On-page indicator** — an animated pill surfaces on any tab an agent is controlling, even in the background
- **Pairing codes** — 6-character codes grant scoped, time-limited access (tab / window / browser)
- **MCP native** — plug directly into Cursor, Claude Desktop, or any MCP client
- **Zero-config local mode** — `python server.py --no-auth` and you're running

## How It Works

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  AI Agent    │  HTTP   │  Carrot Bridge   │   WS    │  Chrome Extension│
│  (Cursor,    │────────▶│  Server          │◀────────│  (your browser)  │
│   Claude,    │  /cmd   │  (cloud or local)│  cmds   │                  │
│   scripts)   │◀────────│                  │────────▶│  executes via    │
│              │ results │                  │ results │  chrome.* APIs   │
└─────────────┘         └──────────────────┘         └──────────────────┘
```

1. **Extension** connects to the bridge server via WebSocket
2. **Agent** sends commands via `POST /cmd` with a session token
3. **Server** routes commands to the correct browser, returns results
4. **Extension** executes commands using Chrome APIs (scripting, tabs, etc.)

## Quick Start

### 1. Install the Chrome Extension

1. Clone this repo
2. Open `chrome://extensions/` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked" and select this folder
5. Click the Carrot icon in your toolbar — the side panel will slide in

### 2a. Hosted Bridge (default)

The extension ships pointing at the hosted bridge at
`https://browser.carrotlabs.ai`. No server setup is required: install the
extension, open the side panel, generate a pairing code, and give that code to
your agent.

The hosted bridge is optional. The server code in this repo is fully
self-hostable if you prefer to run your own bridge or keep traffic on localhost.

### 2b. Local Mode (self-hosted, no auth)

```bash
pip install fastapi uvicorn[standard]
python server.py --no-auth --port 7777
```

Then open the extension options (right-click the toolbar icon > Options) and
set the Server URL to `http://127.0.0.1:7777`. No authentication needed in
local mode.

```bash
# Test the bridge directly
curl -s http://127.0.0.1:7777/status
curl -s -X POST http://127.0.0.1:7777/cmd \
  -H 'Content-Type: application/json' \
  -d '{"type":"readPage"}'
```

To authenticate an agent:

1. Click the Carrot icon — the side panel opens
2. Choose a scope (This Tab, This Window, or All Tabs)
3. Click **Generate Pairing Code**
4. Give the 6-character code to your agent

The agent claims the code:

```bash
curl -s -X POST https://browser.carrotlabs.ai/sessions/claim \
  -H 'Content-Type: application/json' \
  -d '{"code": "A3X7K2", "agent_name": "my-agent"}'
# Returns: {session_token, scope, browser_id, expires_in}
```

Then uses the token for all commands:

```bash
curl -s -X POST https://browser.carrotlabs.ai/cmd \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <session_token>' \
  -d '{"type":"readPage"}'
```

## Security Model

Carrot uses a **pairing-code authentication** model inspired by [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628), Bluetooth numeric comparison, and screen-sharing codes.

### Three-Party Trust

- **Browser extension** authenticates to the server with a `browser_id` + `browser_token` (generated once, stored locally)
- **Agents** authenticate with a **session token** obtained by claiming a pairing code
- **Users** control which agents can access their browser and with what scope

### Pairing Flow

1. User clicks "Generate Pairing Code" in the Carrot side panel
2. Selects scope: **This Tab**, **This Window**, or **All Tabs**
3. Extension requests a pairing code from the server
4. Server generates a 6-character code (valid 5 minutes, single-use)
5. User gives the code to the agent out-of-band
6. Agent calls `POST /sessions/claim` with the code
7. Server returns a session token scoped to the user's selection

### Scoped Access

| Scope | Access |
|---|---|
| `tab:<id>` | Can read, screenshot, navigate, and interact with only the specified tab. Global browser data and multi-tab/window management are blocked. |
| `window:<id>` | Can read, list, and interact with tabs only in the specified window. Browser-wide history/bookmark/download APIs are blocked. |
| `browser` | Full access to all tabs and windows |

### Session Lifecycle

- Sessions default to 8 hours TTL (configurable via `CARROT_SESSION_TTL`)
- Users can view and revoke active sessions from the side panel
- Each session is tied to one browser

## MCP Server

The MCP server wraps the bridge API so any MCP client (Cursor, Claude Code, Claude Desktop) can control Chrome via standard tool calls.

See [mcp-server/README.md](mcp-server/README.md) for setup instructions.

### Quick MCP Setup (Cursor)

The cloud server exposes MCP directly — no local process needed. Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "carrot-browser": {
      "url": "https://browser.carrotlabs.ai/mcp"
    }
  }
}
```

The agent can then use the `claim_session` tool to pair with your browser at runtime.

#### Self-hosted MCP (alternative)

If you're running the server locally, you can use the standalone MCP adapter instead:

```json
{
  "mcpServers": {
    "carrot-browser": {
      "command": "uv",
      "args": ["--directory", "/path/to/carrot-extension/mcp-server", "run", "python", "server.py"],
      "env": {
        "CARROT_BRIDGE_URL": "http://127.0.0.1:7777"
      }
    }
  }
}
```

## API Reference

All agent-facing endpoints require `Authorization: Bearer <token>` when auth is enabled.

### Generic Command

```
POST /cmd
{"type": "<command>", ...params}
```

Default timeout: 30s. Override with `"_timeout": 60`.

### Page Reading

| Command | Description |
|---|---|
| `readPage` | A11y tree with ref IDs for all visible elements |
| `find` | Search by text/aria-label/placeholder |
| `getPageText` | Full text extraction (up to 500k chars) |
| `query` | CSS selector query |

### Interaction

All accept `ref` (from readPage) or `selector` (CSS).

| Command | Description |
|---|---|
| `click` | Click an element |
| `hover` | Hover to trigger states/tooltips |
| `type` | Keyboard typing into an element |
| `formInput` | Set form values (select, checkbox, radio, etc.) |
| `fillContentEditable` | Rich text editors (Gmail, Slack) |
| `scroll` | Scroll page or element |
| `press` | Send keyboard key |

### Navigation

| Command | Description |
|---|---|
| `navigate` | Go to URL |
| `goBack` / `goForward` | Browser history |

### Tab & Window Management

| Command | Description |
|---|---|
| `createTab` / `closeTab` / `reloadTab` | Tab lifecycle |
| `groupTabs` / `ungroupTabs` | Tab groups |
| `createWindow` / `closeWindow` / `resizeWindow` | Window lifecycle |

### Debug

| Command | Description |
|---|---|
| `readConsole` | Console log/warn/error messages |
| `readNetwork` | Fetch/XHR requests with status codes |

### Info Endpoints (GET)

| Endpoint | Returns |
|---|---|
| `/status` | Server status, connected browsers, sessions |
| `/llms.txt` | Agent-facing service description and usage hints |
| `/tabs` | All open tabs |
| `/focused` | Active tab in last-focused window |
| `/windows` | All windows with tabs |
| `/screenshot?tabId=123` | Tab screenshot as data URL; omitting `tabId` captures the visible tab |
| `/history?q=search` | Browser history search |
| `/bookmarks?q=search` | Bookmark search |

### Session Endpoints

| Endpoint | Description |
|---|---|
| `POST /sessions/claim` | Claim a pairing code, get session token |
| `GET /sessions` | List active sessions |

## Scaling & Multi-Server Considerations

The bridge server stores all state in-memory (WebSocket connections, pairing codes, sessions, pending commands). This means **a single server instance is required** for correct operation. If you run multiple instances behind a load balancer, a browser's WebSocket may connect to instance A while an agent's HTTP/MCP request hits instance B — which has no knowledge of that browser's pairing codes or sessions.

### Future: scaling beyond a single instance

When traffic requires multiple machines, the path forward is **Redis as a shared state store**:

1. **Pairing codes & sessions** → Redis keys with TTL (simple key-value, already has expiry semantics)
2. **Pending commands** → Redis pub/sub to relay commands between machines. When machine B receives a command for a browser on machine A, it publishes to a Redis channel; machine A picks it up, sends it over the WebSocket, and publishes the result back.
3. **Browser registry** → Redis hash mapping `browser_id` → machine ID, so any machine can route commands to the correct one.

Other approaches considered:
- **Sticky sessions** (route by client IP/cookie) — simpler but fragile; doesn't help when browser and agent hit different machines
- **Shard by browser_id** (consistent hashing) — scales well but adds routing complexity
- **Single-writer primary** — one machine owns all WebSockets, others proxy to it; simple but creates a bottleneck

## Self-Hosting

You can use the hosted bridge at `https://browser.carrotlabs.ai` if you do not
want to run infrastructure. To run your own bridge instead, run the included
`server.py` app locally or on infrastructure you control.

### Docker

```bash
docker build -t carrot-browser-bridge .
docker run --rm -p 8080:8080 carrot-browser-bridge
```

Then open the extension options and set the Server URL to
`http://127.0.0.1:8080`.

See [DEPLOY.md](DEPLOY.md) for Fly.io and production deployment notes.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CARROT_PORT` | `8080` | Server port |
| `CARROT_NO_AUTH` | `0` | Set to `1` to disable auth |
| `CARROT_SESSION_TTL` | `28800` | Session TTL in seconds (8h) |
| `CARROT_PAIRING_TTL` | `300` | Pairing code TTL in seconds (5min) |

## File Structure

```
carrot-extension/
  manifest.json           Chrome MV3 manifest
  background.js           Service worker: WebSocket, command dispatch,
                          activity broadcasting, tab-control tracking
  content.js              Keepalive + animated on-page overlay
  sidepanel/              Live side-panel UI (HTML / CSS / JS)
  options.html, options.js
                          Server URL & identity configuration
  ui/                     Shared design tokens and Carrot logo module
  assets/
    logo/                 Brand SVG and PNG marks
    icons/                Toolbar icons (16 / 32 / 48 / 128)
  server.py               Bridge server (FastAPI + uvicorn)
  Dockerfile              Self-hostable bridge container
  PRIVACY.md              Canonical open-source privacy policy
  DEPLOY.md               Self-hosting and deployment notes
  requirements.txt        Python dependencies
  deploy/                 Example deployment configs
  mcp-server/             FastMCP wrapper for MCP clients
```

## Contributing

Pull requests welcome. For larger changes, open an issue first so we can
discuss direction.

## License

MIT — see [LICENSE](LICENSE). © Carrot Labs.
