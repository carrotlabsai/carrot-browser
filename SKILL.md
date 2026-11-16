---
name: carrot-browser
description: >-
  Control the user's Chrome browser via the Carrot Bridge Server. Navigate pages,
  read page content, click elements, fill forms, manage tabs/windows, take screenshots,
  read console logs and network traffic. Use when the task requires browser interaction.
---

# Carrot Browser Control

You can control the user's Chrome browser through the Carrot Bridge Server. The Chrome extension connects to the bridge via WebSocket and executes commands.

## Connection Modes

### Local (no auth)
Bridge at `http://127.0.0.1:7777`. Server must be running (`python server.py --no-auth --port 7777`) and extension installed.

### Authenticated Bridge Instance
Bridge at `https://browser.carrotlabs.ai` (the community-hosted instance) or
another bridge URL. Requires a session token when `/status` reports
`auth_required: true`.

Set environment variables:
- `CARROT_BRIDGE_URL` — bridge server URL
- `CARROT_SESSION_TOKEN` — session token (obtained via pairing code)

## Authentication

If the server requires auth (`auth_required: true` in `/status`):

1. Ask the user to generate a pairing code from the Carrot side panel
2. They select a scope (tab, window, or full browser) and click "Generate Access Code"
3. They give you the 6-character code
4. **If using MCP:** call the `claim_session` tool with the code
5. **If using HTTP:** `POST /sessions/claim {"code": "A3X7K2", "agent_name": "your-name"}`
6. Use the returned `session_token` as `Authorization: Bearer <token>` on all requests

Check with `GET /status` — if `auth_required: false`, no pairing is needed.

## How It Works

All browser commands go through a single generic endpoint:

```
POST <bridge_url>/cmd
Content-Type: application/json
Authorization: Bearer <session_token>

{"type": "<command>", ...params}
```

The server queues the command, the extension picks it up, executes it, and returns the result. Default timeout is 30s. Override with `"_timeout": 60`.

For the complete current HTTP route and command reference, read
`<bridge_url>/api.md` (for the community-hosted instance:
`https://browser.carrotlabs.ai/api.md`). The command list below covers the
common workflow and is not the exhaustive browser capability surface.

## Core Workflow

1. **Read the page** to understand what's on screen
2. **Find elements** by text, role, or CSS selector to get `ref` IDs
3. **Interact** using `ref` IDs (click, type, scroll, etc.)
4. **Verify** by reading the page again after actions

## Command Reference

### Page Reading & Element Discovery

**readPage** — Get the accessibility tree with ref IDs for all visible interactive/text elements.

```json
{"type": "readPage"}
{"type": "readPage", "selector": "#main", "maxElements": 200, "tabId": 12345}
```

Returns elements with `ref` IDs like `ref_1`, `ref_2`, etc. Always call this before interacting.

**find** — Search elements by text content, aria-label, or placeholder.

```json
{"type": "find", "query": "Submit", "limit": 5}
{"type": "find", "query": "email", "role": "textbox"}
```

**getPageText** — Extract full text from the page (up to 500k chars).

```json
{"type": "getPageText"}
{"type": "getPageText", "selector": "#article-body", "maxLength": 10000}
```

**query** — CSS selector query, returns refs and text.

```json
{"type": "query", "selector": "button.primary", "limit": 10}
```

### Element Interaction

All interaction commands accept `ref` (preferred, from readPage/find) OR `selector` (CSS). Use `ref` whenever possible — it's more reliable.

**click**

```json
{"type": "click", "ref": "ref_42"}
{"type": "click", "selector": "#submit-btn", "index": 0}
```

**type** — Simulates keyboard typing into an element.

```json
{"type": "type", "ref": "ref_7", "text": "Hello world"}
```

**formInput** — Set form values directly. Works with select, checkbox, radio, input, textarea, contenteditable.

```json
{"type": "formInput", "ref": "ref_7", "value": "option_value"}
```

On a `<select>`, the returned `value` is read about 150 ms after the change
event, so React-controlled selects report the value they settled on. If the
select was replaced or the page navigated, the result has `"settled": false`.

**fillContentEditable** — Fill rich text editors (Slack, Gmail compose, etc.). Auto-scrolls to find the element.

```json
{"type": "fillContentEditable", "ref": "ref_15", "text": "Message body", "maxScrolls": 5}
```

**hover**

```json
{"type": "hover", "ref": "ref_3"}
```

**scroll**

```json
{"type": "scroll", "direction": "down", "amount": 500}
{"type": "scroll", "ref": "ref_10", "direction": "up"}
```

**press**: Press a key or shortcut as trusted input (through the Chrome debugger).

```json
{"type": "press", "key": "Enter"}
{"type": "press", "key": "Tab", "ref": "ref_5"}
{"type": "press", "key": "Shift+Tab"}
{"type": "press", "key": "Meta+v", "ref": "ref_12"}
```

Combine modifiers with `+` (`Shift`, `Control`/`Ctrl`, `Alt`/`Option`,
`Meta`/`Cmd`); `Mod+` means Meta on macOS and Control elsewhere. On macOS,
`Meta+a`, `Meta+c`, `Meta+x`, `Meta+v`, `Meta+z`, and `Shift+Meta+z` perform
select all, copy, cut, paste, undo, and redo. With `ref` or `selector`, the
element is focused first. If the debugger is unavailable, or the element cannot
take focus, Carrot falls back to synthetic events; `method` in the result says
which ran.

### Navigation

```json
{"type": "navigate", "url": "https://example.com"}
{"type": "navigate", "url": "https://example.com", "waitUntil": "domcontentloaded", "timeoutMs": 30000}
{"type": "goBack"}
{"type": "goForward"}
```

`navigate`, `goBack`, `goForward`, `reloadTab`, and `createTab` wait until the
new page has loaded before returning, so the next command runs against the new
document. `waitUntil` is `load` (default), `domcontentloaded`, or `none`;
`timeoutMs` defaults to 20000. The result has the final `url`, `title`,
`status`, and `loaded`, plus `timedOut` or `navigationError` when the load did
not finish.

### Tab Management

```json
{"type": "createTab", "url": "https://example.com", "active": true}
{"type": "closeTab", "tabId": 12345}
{"type": "reloadTab", "bypassCache": true}
{"type": "duplicateTab"}
{"type": "pinTab", "pinned": true}
{"type": "muteTab", "muted": true}
{"type": "moveTab", "index": 0}
{"type": "groupTabs", "tabIds": [1, 2, 3], "title": "Research", "color": "blue"}
{"type": "ungroupTabs", "tabIds": [1, 2, 3]}
```

### Window Management

```json
{"type": "createWindow", "url": "https://example.com", "state": "maximized"}
{"type": "updateWindow", "windowId": 1, "state": "minimized"}
{"type": "closeWindow", "windowId": 1}
{"type": "resizeWindow", "width": 1200, "height": 800}
```

### Debug Tools

**readConsole** — Install console interceptor and get buffered log/warn/error messages.

```json
{"type": "readConsole", "install": true}
```

First call with `install: true`, subsequent calls without it to read new messages.

**readNetwork** — Install fetch/XHR interceptor and get buffered requests with status codes.

```json
{"type": "readNetwork", "install": true}
```

### Screenshots

```
GET /screenshot
GET /screenshot?tabId=123&maxWidth=1280
```

Returns a screenshot as a data URL with the image `width` and `height`, the CSS
`viewport` (`width`, `height`, `devicePixelRatio`, `scrollX`, `scrollY`), and
`cssPixelsPerImagePixel`. Pass `tabId` to target a specific tab; otherwise it
captures the visible tab. `maxWidth` downscales the image, never wider than the
CSS viewport. To click something you see in the image, multiply its image
coordinates by `cssPixelsPerImagePixel` and send `clickAt` with
`"coordinateSpace": "viewport"`.

The MCP `take_screenshot` tool returns the image as MCP image content, 1280 px
wide at most by default (`max_width`, 0 for full resolution), plus the same
viewport details as text.

### JS Execution

```
POST /execute
{"script": "document.title", "tabId": 12345}
```

If the page's Content Security Policy blocks eval (claude.ai, for example), the
top frame is retried through the Chrome debugger (`Runtime.evaluate`), which
also awaits promises. Frame-targeted and ISOLATED-world scripts have no such
fallback. Prefer readPage + click/type for interaction.

### Info Endpoints (GET)

| Endpoint | Returns |
|---|---|
| `/focused` | Active tab in last-focused window |
| `/tabs` | All open tabs |
| `/windows` | All windows with their tabs |
| `/groups` | Tab groups |
| `/history?q=search&maxResults=100` | Browser history search |
| `/bookmarks?q=search` | Bookmark search |
| `/bookmark_tree` | Full bookmark tree |
| `/status` | Server connection status |

## Usage from Shell

```bash
# Check server (local, no auth)
curl -s http://127.0.0.1:7777/status | python3 -m json.tool

# Read the current page (authenticated bridge)
curl -s -X POST https://browser.carrotlabs.ai/cmd \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"type":"readPage"}' | python3 -m json.tool

# Click an element
curl -s -X POST <bridge_url>/cmd \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"type":"click","ref":"ref_5"}'

# Navigate
curl -s -X POST <bridge_url>/navigate \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"url":"https://google.com"}'
```

## Important Notes

- Always `readPage` before interacting — you need `ref` IDs.
- Use `ref` over `selector` when both are available.
- `formInput` is better than `type` for setting form values (selects, checkboxes, etc.).
- `fillContentEditable` handles rich text editors that `type` and `formInput` can't.
- Console/network interceptors must be installed once per page load with `install: true`.
- `tabId` is optional in most commands — omit it to target the active tab.
- Sessions are scoped: `tab:<id>`, `window:<id>`, or `browser`. Respect the scope the user granted.
