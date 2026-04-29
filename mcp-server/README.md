# Carrot MCP Server

MCP server that exposes Chrome browser control via the [Carrot Bridge](../server.py) server. Any MCP client (Claude Code, Cursor, etc.) can use it to navigate pages, click elements, fill forms, manage tabs, take screenshots, and more.

## Prerequisites

1. **Carrot Bridge Server** running (local or cloud)
2. **Carrot Chrome Extension** installed and connected to the bridge

## Setup

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CARROT_BRIDGE_URL` | `http://127.0.0.1:7777` | Bridge server URL. Use `https://browser.carrotlabs.ai` for the hosted Carrot bridge. |
| `CARROT_SESSION_TOKEN` | _(empty)_ | Session token for authenticated access |

For **local development** (no auth), the defaults work out of the box.

For **cloud servers**, set the URL and either provide a token or use the `claim_session` tool at runtime.

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` or global settings):

```json
{
  "mcpServers": {
    "carrot": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/carrot-extension/mcp-server", "run", "python", "server.py"],
      "env": {
        "CARROT_BRIDGE_URL": "https://browser.carrotlabs.ai",
        "CARROT_SESSION_TOKEN": ""
      }
    }
  }
}
```

### Claude Code

```bash
# Local (no auth)
claude mcp add carrot -- uv --directory /ABSOLUTE/PATH/TO/carrot-extension/mcp-server run python server.py

# Cloud (set env vars before running)
CARROT_BRIDGE_URL=https://browser.carrotlabs.ai claude mcp add carrot -- uv --directory /ABSOLUTE/PATH/TO/carrot-extension/mcp-server run python server.py
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "carrot": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/carrot-extension/mcp-server", "run", "python", "server.py"],
      "env": {
        "CARROT_BRIDGE_URL": "https://browser.carrotlabs.ai"
      }
    }
  }
}
```

## Authentication Flow

When connecting to a cloud bridge server (auth required):

1. The user generates a **pairing code** in the Carrot side panel
2. The agent calls the `claim_session` MCP tool with that code
3. The tool automatically sets the session token for all subsequent requests
4. The session persists for the duration of the MCP server process (default 8 hours)

## Available Tools (34)

### Session Management
- `claim_session` -- Pair with a browser using a pairing code

### Page Reading
- `read_page` -- Get accessibility tree with ref IDs (call this first!)
- `find` -- Search elements by text/aria-label/placeholder
- `get_page_text` -- Full text extraction
- `css_query` -- CSS selector query

### Interaction
- `click` -- Click an element by ref or selector
- `hover` -- Hover over an element
- `type_text` -- Type into an element
- `form_input` -- Set form field values (select, checkbox, radio, etc.)
- `fill_content_editable` -- Fill rich text editors (Gmail, Slack, etc.)
- `scroll` -- Scroll page or element
- `press_key` -- Send keyboard key press

### Navigation
- `navigate` -- Go to a URL
- `go_back` / `go_forward` -- Browser history

### Tab Management
- `list_tabs` / `focused_tab` -- Query tabs
- `create_tab` / `close_tab` / `reload_tab`
- `group_tabs` / `ungroup_tabs`

### Window Management
- `list_windows` / `create_window` / `close_window` / `resize_window`

### Debug
- `read_console` -- Page console logs
- `read_network` -- Network request log

### Other
- `screenshot` -- Capture visible tab, or pass `tab_id` for a specific tab
- `execute_js` -- Run arbitrary JavaScript
- `search_history` / `search_bookmarks` / `bookmark_tree`
- `status` -- Check bridge connection
