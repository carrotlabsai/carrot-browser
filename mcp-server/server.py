#!/usr/bin/env python3
"""
Carrot Standalone MCP Adapter — exposes a Carrot Bridge as MCP tools.

Wraps the Carrot Bridge HTTP API so any MCP client (Claude Code, Cursor, etc.)
can control Chrome via standard MCP tool calls.

This is optional client-side adapter plumbing. The main bridge server in
../server.py already exposes MCP directly at /mcp. Use this adapter for MCP
clients that need a local stdio/SSE process pointed at any bridge URL.

Env vars:
    CARROT_BRIDGE_URL      — bridge server URL (default: http://127.0.0.1:7777)
    CARROT_SESSION_TOKEN   — session token for authenticated access

Run this MCP server:
    python server.py          # stdio (default)
    python server.py --sse    # SSE transport
"""
from __future__ import annotations

import os

import httpx
from mcp.server.fastmcp import FastMCP

BRIDGE = os.environ.get("CARROT_BRIDGE_URL", "http://127.0.0.1:7777").rstrip("/")
SESSION_TOKEN = os.environ.get("CARROT_SESSION_TOKEN", "")

mcp = FastMCP(
    "carrot",
    instructions=(
        "Carrot controls the user's Chrome browser via a bridge server. "
        "Always call read_page before interacting with elements — you need ref IDs. "
        "Use ref IDs (e.g. ref_42) from read_page/find results for click, type, form_input, etc. "
        "Most commands target the active tab by default; pass tabId for automation on another tab without switching it. "
        "Use activate_tab with an id from list_tabs to focus Chrome and switch the tab the user sees. "
        "If the server requires authentication, use claim_session with a pairing code first."
    ),
)


def _auth_headers() -> dict[str, str]:
    if SESSION_TOKEN:
        return {"Authorization": f"Bearer {SESSION_TOKEN}"}
    return {}


async def _bridge_cmd(type_: str, timeout: float = 30.0, **kwargs) -> dict:
    """Send a command to the Carrot Bridge and return the result."""
    payload = {"type": type_, **kwargs}
    if timeout != 30.0:
        payload["_timeout"] = timeout
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BRIDGE}/cmd",
            json=payload,
            headers=_auth_headers(),
            timeout=timeout + 5,
        )
        data = resp.json()
    if "error" in data and data["error"]:
        raise ValueError(data["error"])
    return data.get("result", data)


async def _bridge_get(path: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BRIDGE}{path}",
            params=params,
            headers=_auth_headers(),
            timeout=35,
        )
        return resp.json()


async def _bridge_post(path: str, body: dict) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BRIDGE}{path}",
            json=body,
            headers=_auth_headers(),
            timeout=35,
        )
        return resp.json()


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

@mcp.tool()
async def claim_session(code: str, agent_name: str = "mcp-agent") -> str:
    """Claim an agent session using a pairing code from the browser extension.

    The user generates a 6-character code in the Carrot side panel and
    gives it to you. Call this tool with that code to authenticate. The returned
    session_token should be set as CARROT_SESSION_TOKEN for subsequent requests.
    """
    global SESSION_TOKEN
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BRIDGE}/sessions/claim",
            json={"code": code, "agent_name": agent_name},
            timeout=10,
        )
        data = resp.json()
    if resp.status_code != 200:
        raise ValueError(data.get("detail", "Failed to claim session"))
    SESSION_TOKEN = data["session_token"]
    return (
        f"Session claimed. scope={data['scope']}, "
        f"expires_in={data['expires_in']}s. "
        f"Token set automatically for this session."
    )


# ---------------------------------------------------------------------------
# Page reading & element discovery
# ---------------------------------------------------------------------------

@mcp.tool()
async def read_page(
    selector: str | None = None,
    max_elements: int | None = None,
    tab_id: int | None = None,
) -> str:
    """Read the accessibility tree of the current page. Returns elements with ref IDs
    (ref_1, ref_2, ...) that you must use for click, type, form_input, etc.

    ALWAYS call this before interacting with any page elements.
    """
    kwargs = {}
    if selector:
        kwargs["selector"] = selector
    if max_elements is not None:
        kwargs["maxElements"] = max_elements
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("readPage", **kwargs)
    return str(result)


@mcp.tool()
async def find(
    query: str,
    role: str | None = None,
    limit: int | None = None,
    tab_id: int | None = None,
) -> str:
    """Search for elements by text content, aria-label, or placeholder. Returns ref IDs."""
    kwargs: dict = {"query": query}
    if role:
        kwargs["role"] = role
    if limit is not None:
        kwargs["limit"] = limit
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("find", **kwargs)
    return str(result)


@mcp.tool()
async def get_page_text(
    selector: str | None = None,
    max_length: int | None = None,
    tab_id: int | None = None,
) -> str:
    """Extract the full text content from the page (up to 500k chars)."""
    kwargs = {}
    if selector:
        kwargs["selector"] = selector
    if max_length is not None:
        kwargs["maxLength"] = max_length
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("getPageText", **kwargs)
    return str(result)


@mcp.tool()
async def css_query(
    selector: str,
    limit: int = 50,
    tab_id: int | None = None,
) -> str:
    """Query elements by CSS selector. Returns refs and text content."""
    kwargs: dict = {"selector": selector, "limit": limit}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("query", **kwargs)
    return str(result)


# ---------------------------------------------------------------------------
# Interaction
# ---------------------------------------------------------------------------

@mcp.tool()
async def click(
    ref: str | None = None,
    selector: str | None = None,
    index: int | None = None,
    tab_id: int | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Click an element. Prefer ref (from read_page) over selector. Use frame_id or frame_selector for iframe content."""
    kwargs = {}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if index is not None:
        kwargs["index"] = index
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_id is not None:
        kwargs["frameId"] = frame_id
    if frame_selector:
        kwargs["frameSelector"] = frame_selector
    result = await _bridge_cmd("click", **kwargs)
    return str(result)


@mcp.tool()
async def hover(
    ref: str | None = None,
    selector: str | None = None,
    tab_id: int | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Hover over an element to trigger hover states or tooltips."""
    kwargs = {}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_id is not None:
        kwargs["frameId"] = frame_id
    if frame_selector:
        kwargs["frameSelector"] = frame_selector
    result = await _bridge_cmd("hover", **kwargs)
    return str(result)


@mcp.tool()
async def type_text(
    text: str,
    ref: str | None = None,
    selector: str | None = None,
    tab_id: int | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Type text into an element via simulated keyboard input."""
    kwargs: dict = {"text": text}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_id is not None:
        kwargs["frameId"] = frame_id
    if frame_selector:
        kwargs["frameSelector"] = frame_selector
    result = await _bridge_cmd("type", **kwargs)
    return str(result)


@mcp.tool()
async def form_input(
    value: str,
    ref: str | None = None,
    selector: str | None = None,
    tab_id: int | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Set a form field value directly. Works with select, checkbox, radio,
    input, textarea, and contenteditable elements.
    """
    kwargs: dict = {"value": value}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_id is not None:
        kwargs["frameId"] = frame_id
    if frame_selector:
        kwargs["frameSelector"] = frame_selector
    result = await _bridge_cmd("formInput", **kwargs)
    return str(result)


@mcp.tool()
async def fill_content_editable(
    text: str,
    ref: str | None = None,
    selector: str | None = None,
    max_scrolls: int | None = None,
    tab_id: int | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Fill a rich text / contenteditable element (Gmail compose, Slack, etc.).
    Auto-scrolls to find the element if needed.
    """
    kwargs: dict = {"text": text}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if max_scrolls is not None:
        kwargs["maxScrolls"] = max_scrolls
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_id is not None:
        kwargs["frameId"] = frame_id
    if frame_selector:
        kwargs["frameSelector"] = frame_selector
    result = await _bridge_cmd("fillContentEditable", **kwargs)
    return str(result)


@mcp.tool()
async def scroll(
    direction: str = "down",
    amount: int | None = None,
    ref: str | None = None,
    selector: str | None = None,
    tab_id: int | None = None,
) -> str:
    """Scroll the page or a specific element. direction: up/down/left/right."""
    kwargs: dict = {"direction": direction}
    if amount is not None:
        kwargs["amount"] = amount
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("scroll", **kwargs)
    return str(result)


@mcp.tool()
async def press_key(
    key: str,
    ref: str | None = None,
    selector: str | None = None,
    tab_id: int | None = None,
) -> str:
    """Send a keyboard key press (Enter, Tab, Escape, ArrowDown, etc.)."""
    kwargs: dict = {"key": key}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("press", **kwargs)
    return str(result)


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------

@mcp.tool()
async def navigate(url: str, tab_id: int | None = None) -> str:
    """Navigate the active tab (or a specific tab) to a URL."""
    body: dict = {"url": url}
    if tab_id is not None:
        body["tabId"] = tab_id
    result = await _bridge_post("/navigate", body)
    return str(result)


@mcp.tool()
async def go_back(tab_id: int | None = None) -> str:
    """Go back in browser history."""
    kwargs = {}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("goBack", **kwargs)
    return str(result)


@mcp.tool()
async def go_forward(tab_id: int | None = None) -> str:
    """Go forward in browser history."""
    kwargs = {}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("goForward", **kwargs)
    return str(result)


# ---------------------------------------------------------------------------
# Tab management
# ---------------------------------------------------------------------------

@mcp.tool()
async def list_tabs() -> str:
    """List all open browser tabs with their IDs, titles, and URLs."""
    result = await _bridge_get("/tabs")
    return str(result)


@mcp.tool()
async def focused_tab() -> str:
    """Get the active tab in the last-focused window."""
    result = await _bridge_get("/focused")
    return str(result)


@mcp.tool()
async def activate_tab(tab_id: int) -> str:
    """Focus Chrome and activate this tab in the strip (matches the user clicking the tab)."""
    result = await _bridge_cmd("activateTab", tabId=tab_id)
    return str(result)


@mcp.tool()
async def create_tab(
    url: str | None = None,
    active: bool = True,
    pinned: bool = False,
    window_id: int | None = None,
) -> str:
    """Create a new browser tab."""
    kwargs: dict = {"active": active, "pinned": pinned}
    if url:
        kwargs["url"] = url
    if window_id is not None:
        kwargs["windowId"] = window_id
    result = await _bridge_cmd("createTab", **kwargs)
    return str(result)


@mcp.tool()
async def close_tab(tab_id: int) -> str:
    """Close a specific tab by ID."""
    result = await _bridge_cmd("closeTab", tabId=tab_id)
    return str(result)


@mcp.tool()
async def reload_tab(
    tab_id: int | None = None,
    bypass_cache: bool = False,
) -> str:
    """Reload a tab. Optionally bypass cache."""
    kwargs: dict = {"bypassCache": bypass_cache}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("reloadTab", **kwargs)
    return str(result)


@mcp.tool()
async def group_tabs(
    tab_ids: list[int],
    title: str | None = None,
    color: str | None = None,
    collapsed: bool = False,
) -> str:
    """Group tabs together with an optional title and color."""
    kwargs: dict = {"tabIds": tab_ids, "collapsed": collapsed}
    if title:
        kwargs["title"] = title
    if color:
        kwargs["color"] = color
    result = await _bridge_cmd("groupTabs", **kwargs)
    return str(result)


@mcp.tool()
async def ungroup_tabs(tab_ids: list[int]) -> str:
    """Remove tabs from their group."""
    result = await _bridge_cmd("ungroupTabs", tabIds=tab_ids)
    return str(result)


# ---------------------------------------------------------------------------
# Window management
# ---------------------------------------------------------------------------

@mcp.tool()
async def list_windows() -> str:
    """List all browser windows with their tabs."""
    result = await _bridge_get("/windows")
    return str(result)


@mcp.tool()
async def create_window(
    url: str | None = None,
    state: str | None = None,
    incognito: bool = False,
    width: int | None = None,
    height: int | None = None,
) -> str:
    """Create a new browser window. state: normal/minimized/maximized/fullscreen."""
    kwargs: dict = {"incognito": incognito}
    if url:
        kwargs["url"] = url
    if state:
        kwargs["state"] = state
    if width is not None:
        kwargs["width"] = width
    if height is not None:
        kwargs["height"] = height
    result = await _bridge_cmd("createWindow", **kwargs)
    return str(result)


@mcp.tool()
async def close_window(window_id: int) -> str:
    """Close a browser window by ID."""
    result = await _bridge_cmd("closeWindow", windowId=window_id)
    return str(result)


@mcp.tool()
async def resize_window(
    window_id: int | None = None,
    width: int | None = None,
    height: int | None = None,
    left: int | None = None,
    top: int | None = None,
) -> str:
    """Resize and/or reposition a browser window."""
    kwargs = {}
    if window_id is not None:
        kwargs["windowId"] = window_id
    if width is not None:
        kwargs["width"] = width
    if height is not None:
        kwargs["height"] = height
    if left is not None:
        kwargs["left"] = left
    if top is not None:
        kwargs["top"] = top
    result = await _bridge_cmd("resizeWindow", **kwargs)
    return str(result)


# ---------------------------------------------------------------------------
# Debug tools
# ---------------------------------------------------------------------------

@mcp.tool()
async def read_console(
    install: bool = True,
    tab_id: int | None = None,
) -> str:
    """Read console log/warn/error messages from the page.
    First call with install=True to inject the interceptor, then call
    without install to read new messages.
    """
    kwargs: dict = {"install": install}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("readConsole", **kwargs)
    return str(result)


@mcp.tool()
async def read_network(
    install: bool = True,
    tab_id: int | None = None,
) -> str:
    """Read network requests (fetch/XHR) with status codes from the page.
    First call with install=True to inject the interceptor, then call
    without install to read new requests.
    """
    kwargs: dict = {"install": install}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("readNetwork", **kwargs)
    return str(result)


# ---------------------------------------------------------------------------
# Screenshots & JS execution
# ---------------------------------------------------------------------------

@mcp.tool()
async def resolve_frame(
    frame_selector: str,
    tab_id: int | None = None,
    frame_index: int | None = None,
) -> str:
    """Resolve an iframe CSS selector to a Chrome frameId for later frame-targeted commands."""
    kwargs: dict = {"frameSelector": frame_selector}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if frame_index is not None:
        kwargs["frameIndex"] = frame_index
    result = await _bridge_cmd("resolveFrame", **kwargs)
    return str(result)


@mcp.tool()
async def click_at(
    x: float,
    y: float,
    tab_id: int | None = None,
    coordinate_space: str = "page",
    scroll_into_view: bool = True,
) -> str:
    """Click absolute page coordinates using Chrome debugger input dispatch."""
    kwargs: dict = {
        "x": x,
        "y": y,
        "coordinateSpace": coordinate_space,
        "scrollIntoView": scroll_into_view,
    }
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    result = await _bridge_cmd("clickAt", **kwargs)
    return str(result)


@mcp.tool()
async def screenshot(
    window_id: int | None = None,
    tab_id: int | None = None,
    format: str | None = None,
) -> str:
    """Capture a screenshot. Pass tab_id to target a specific tab."""
    params = {}
    if tab_id is not None:
        params["tabId"] = str(tab_id)
    if window_id is not None:
        params["windowId"] = str(window_id)
    if format:
        params["format"] = format
    result = await _bridge_get("/screenshot", params=params or None)
    return str(result)


@mcp.tool()
async def execute_js(
    script: str,
    tab_id: int | None = None,
    world: str | None = None,
    frame_id: int | None = None,
    frame_selector: str | None = None,
) -> str:
    """Execute JavaScript in the page. May fail on Trusted Types sites (YouTube, etc.).
    Prefer read_page + click/type for standard interaction.
    """
    body: dict = {"script": script}
    if tab_id is not None:
        body["tabId"] = tab_id
    if world:
        body["world"] = world
    if frame_id is not None:
        body["frameId"] = frame_id
    if frame_selector:
        body["frameSelector"] = frame_selector
    result = await _bridge_post("/execute", body)
    return str(result)


# ---------------------------------------------------------------------------
# History & bookmarks
# ---------------------------------------------------------------------------

@mcp.tool()
async def search_history(
    query: str = "",
    max_results: int = 100,
    start_time: float | None = None,
) -> str:
    """Search browser history."""
    params: dict = {"q": query, "maxResults": str(max_results)}
    if start_time is not None:
        params["startTime"] = str(start_time)
    result = await _bridge_get("/history", params=params)
    return str(result)


@mcp.tool()
async def search_bookmarks(query: str = "") -> str:
    """Search bookmarks by query string."""
    result = await _bridge_get("/bookmarks", params={"q": query})
    return str(result)


@mcp.tool()
async def bookmark_tree() -> str:
    """Get the full bookmark tree."""
    result = await _bridge_get("/bookmark_tree")
    return str(result)


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@mcp.tool()
async def status() -> str:
    """Check if the Carrot Bridge server is running and the extension is connected."""
    result = await _bridge_get("/status")
    return str(result)


def main():
    import sys
    transport = "sse" if "--sse" in sys.argv else "stdio"
    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
