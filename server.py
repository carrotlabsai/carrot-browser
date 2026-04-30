#!/usr/bin/env python3
"""
Carrot Bridge Server — multi-tenant broker between AI agents and Chrome extensions.

Agents send commands via HTTP, browser extensions connect via WebSocket.
Supports pairing-code authentication (RFC 8628-style device flow) and
scoped sessions (tab, window, or full browser access).

Local mode (--no-auth):
    python server.py --no-auth          # like the old localhost-only server

Cloud mode (default):
    uvicorn server:app --host 0.0.0.0 --port 8080

Env vars:
    CARROT_PORT          — port to listen on (default: 8080)
    CARROT_NO_AUTH       — set to "1" to disable auth (local dev only)
    CARROT_SESSION_TTL   — session TTL in seconds (default: 28800 = 8h)
    CARROT_PAIRING_TTL   — pairing code TTL in seconds (default: 300 = 5min)
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import secrets
import string
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from starlette.routing import Mount

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.server import StreamableHTTPSessionManager, StreamableHTTPASGIApp
from mcp.server.transport_security import TransportSecuritySettings

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NO_AUTH = os.environ.get("CARROT_NO_AUTH", "0") == "1"
SESSION_TTL = int(os.environ.get("CARROT_SESSION_TTL", "28800"))
PAIRING_TTL = int(os.environ.get("CARROT_PAIRING_TTL", "300"))
RESULT_TTL = 300
PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no O/0/I/1/l
SERVICE_STARTED_AT = time.time()

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class BrowserConnection:
    browser_id: str
    token_hash: str
    name: str
    ws: WebSocket | None = None
    connected_at: float = 0.0


@dataclass
class Session:
    session_id: str
    token_hash: str
    browser_id: str
    scope: str  # "browser", "window:<id>", "tab:<id>"
    agent_name: str
    created: float = field(default_factory=time.time)
    expires: float = 0.0


@dataclass
class PairingCode:
    code: str
    browser_id: str
    scope: str
    expires: float
    claimed: bool = False


@dataclass
class PendingCommand:
    cmd_id: str
    payload: dict
    future: asyncio.Future
    session_id: str | None
    created: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# State (in-memory, per-process)
# ---------------------------------------------------------------------------

browsers: dict[str, BrowserConnection] = {}
sessions: dict[str, Session] = {}
pairing_codes: dict[str, PairingCode] = {}
pending_commands: dict[str, dict[str, PendingCommand]] = {}  # browser_id -> {cmd_id -> cmd}

_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _generate_pairing_code() -> str:
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(6))


def _check_scope(session_scope: str, cmd: dict) -> bool:
    """Return True if the command is allowed under the session's scope."""
    if session_scope == "browser":
        return True
    kind, _, scope_id = session_scope.partition(":")
    if not scope_id:
        return True
    scope_id_int = int(scope_id)
    cmd_tab = cmd.get("tabId")
    cmd_window = cmd.get("windowId")
    if kind == "tab":
        if cmd_tab is not None and cmd_tab != scope_id_int:
            return False
    elif kind == "window":
        if cmd_window is not None and cmd_window != scope_id_int:
            return False
    return True


TAB_SCOPE_COMMANDS = {
    "focused", "tabs",
    "navigate", "closeTab", "reloadTab", "pinTab", "muteTab", "discardTab",
    "screenshot",
    "readPage", "find", "getPageText", "dom", "query",
    "click", "hover", "type", "formInput", "scroll", "press",
    "fillContentEditable",
    "goBack", "goForward",
    "readConsole", "readNetwork", "execute",
}

WINDOW_SCOPE_COMMANDS = TAB_SCOPE_COMMANDS | {
    "getWindows", "createTab", "duplicateTab", "moveTab",
    "groupTabs", "ungroupTabs", "updateGroup", "queryGroups",
    "updateWindow", "closeWindow", "resizeWindow",
}

TAB_TARGETED_COMMANDS = {
    "navigate", "closeTab", "reloadTab", "pinTab", "muteTab", "discardTab",
    "screenshot",
    "readPage", "find", "getPageText", "dom", "query",
    "click", "hover", "type", "formInput", "scroll", "press",
    "fillContentEditable",
    "goBack", "goForward",
    "readConsole", "readNetwork", "execute",
}

WINDOW_TARGETED_COMMANDS = {
    "tabs", "focused", "getWindows", "createTab", "queryGroups",
    "updateWindow", "closeWindow", "resizeWindow",
}


def _apply_scope(session: Session | None, cmd_type: str, params: dict) -> dict:
    """Return params constrained to the session scope, or raise on policy denial."""
    if not session or session.scope == "browser":
        return params

    kind, _, scope_id = session.scope.partition(":")
    if not scope_id:
        return params
    scoped_id = int(scope_id)
    scoped = dict(params)

    if kind == "tab":
        if cmd_type not in TAB_SCOPE_COMMANDS:
            raise HTTPException(403, f"Command not allowed for tab scope: {cmd_type}")
        tab_id = scoped.get("tabId")
        if tab_id is not None and tab_id != scoped_id:
            raise HTTPException(403, f"Command outside session scope ({session.scope})")
        if cmd_type in TAB_TARGETED_COMMANDS or cmd_type in {"tabs", "focused"}:
            scoped["tabId"] = scoped_id
            scoped.pop("windowId", None)
        return scoped

    if kind == "window":
        if cmd_type not in WINDOW_SCOPE_COMMANDS:
            raise HTTPException(403, f"Command not allowed for window scope: {cmd_type}")
        window_id = scoped.get("windowId")
        if window_id is not None and window_id != scoped_id:
            raise HTTPException(403, f"Command outside session scope ({session.scope})")
        if cmd_type in WINDOW_TARGETED_COMMANDS:
            scoped["windowId"] = scoped_id
        if cmd_type == "queryGroups":
            query_info = dict(scoped.get("queryInfo") or {})
            query_info["windowId"] = scoped_id
            scoped["queryInfo"] = query_info
        if cmd_type in TAB_TARGETED_COMMANDS and scoped.get("tabId") is None:
            scoped["windowId"] = scoped_id
        if cmd_type == "createTab":
            scoped["windowId"] = scoped_id
        return scoped

    return params


def _agent_payload(session: Session | None) -> dict | None:
    if not session:
        return None
    return {
        "session_id": session.session_id,
        "agent_name": session.agent_name,
        "scope": session.scope,
    }


async def _cleanup_loop():
    """Periodic cleanup of expired sessions, pairing codes, and stale commands."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        async with _lock:
            expired_sessions = [
                sid for sid, s in sessions.items() if s.expires > 0 and now > s.expires
            ]
            for sid in expired_sessions:
                del sessions[sid]
            expired_codes = [
                c for c, p in pairing_codes.items() if now > p.expires
            ]
            for c in expired_codes:
                del pairing_codes[c]
            for bid in list(pending_commands):
                stale = [
                    cid for cid, cmd in pending_commands[bid].items()
                    if now - cmd.created > RESULT_TTL
                ]
                for cid in stale:
                    cmd = pending_commands[bid].pop(cid)
                    if not cmd.future.done():
                        cmd.future.set_result({"error": "expired"})


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------

async def _get_session(request: Request) -> Session | None:
    """Extract and validate a session from the Authorization header."""
    if NO_AUTH:
        return None
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing or invalid Authorization header. Use: Bearer <session_token>")
    token = auth[7:]
    token_h = _hash(token)
    async with _lock:
        for s in sessions.values():
            if s.token_hash == token_h:
                if s.expires > 0 and time.time() > s.expires:
                    raise HTTPException(401, "Session expired")
                return s
    raise HTTPException(401, "Invalid session token")


async def _get_browser_id(session: Session | None = Depends(_get_session)) -> str:
    """Resolve the browser_id from the session (or use the single connected browser in no-auth mode)."""
    if session is not None:
        return session.browser_id
    async with _lock:
        connected = [bid for bid, b in browsers.items() if b.ws is not None]
    if len(connected) == 1:
        return connected[0]
    if len(connected) == 0:
        raise HTTPException(503, "No browser connected")
    raise HTTPException(400, "Multiple browsers connected. Auth required to disambiguate — set CARROT_NO_AUTH=0")


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app_: FastAPI):
    task = asyncio.create_task(_cleanup_loop())
    async with _mcp_session_mgr.run():
        yield
    task.cancel()

app = FastAPI(title="Carrot Bridge", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# WebSocket: browser extension connection
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    browser_id: str = Query(...),
    browser_token: str = Query(...),
):
    token_h = _hash(browser_token)
    async with _lock:
        existing = browsers.get(browser_id)
        if existing is None:
            browsers[browser_id] = BrowserConnection(
                browser_id=browser_id,
                token_hash=token_h,
                name="",
                connected_at=time.time(),
            )
        elif existing.token_hash != token_h:
            await websocket.close(code=4001, reason="Invalid browser token")
            return
        pending_commands.setdefault(browser_id, {})

    await websocket.accept()
    browsers[browser_id].ws = websocket
    browsers[browser_id].connected_at = time.time()

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            action = msg.get("action")

            if action == "complete":
                cmd_id = msg.get("id")
                async with _lock:
                    cmd = pending_commands.get(browser_id, {}).get(cmd_id)
                if cmd and not cmd.future.done():
                    cmd.future.set_result({
                        "result": msg.get("result"),
                        "error": msg.get("error"),
                    })

            elif action == "create_pairing":
                scope = msg.get("scope", "browser")
                agent_name = msg.get("agent_name", "")
                code = _generate_pairing_code()
                async with _lock:
                    pairing_codes[code] = PairingCode(
                        code=code,
                        browser_id=browser_id,
                        scope=scope,
                        expires=time.time() + PAIRING_TTL,
                    )
                await websocket.send_text(json.dumps({
                    "action": "pairing_code",
                    "code": code,
                    "expires_in": PAIRING_TTL,
                    "scope": scope,
                }))

            elif action == "list_sessions":
                async with _lock:
                    browser_sessions = [
                        {
                            "session_id": s.session_id,
                            "agent_name": s.agent_name,
                            "scope": s.scope,
                            "created": s.created,
                            "expires": s.expires,
                        }
                        for s in sessions.values()
                        if s.browser_id == browser_id
                    ]
                await websocket.send_text(json.dumps({
                    "action": "sessions_list",
                    "sessions": browser_sessions,
                }))

            elif action == "revoke_session":
                session_id = msg.get("session_id")
                async with _lock:
                    s = sessions.get(session_id)
                    if s and s.browser_id == browser_id:
                        del sessions[session_id]
                await websocket.send_text(json.dumps({
                    "action": "session_revoked",
                    "session_id": session_id,
                }))

            elif action == "set_name":
                browsers[browser_id].name = msg.get("name", "")

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if browsers.get(browser_id) and browsers[browser_id].ws is websocket:
            browsers[browser_id].ws = None


# ---------------------------------------------------------------------------
# HTTP: session claim (agent pairs with browser via code)
# ---------------------------------------------------------------------------

@app.post("/sessions/claim")
async def claim_session(body: dict):
    code_str = body.get("code", "").upper().strip()
    agent_name = body.get("agent_name", "anonymous")
    if not code_str:
        raise HTTPException(400, "code is required")
    async with _lock:
        pc = pairing_codes.get(code_str)
        if not pc or pc.claimed or time.time() > pc.expires:
            raise HTTPException(404, "Invalid or expired pairing code")
        pc.claimed = True
        session_id = uuid.uuid4().hex[:16]
        session_token = secrets.token_urlsafe(32)
        session = Session(
            session_id=session_id,
            token_hash=_hash(session_token),
            browser_id=pc.browser_id,
            scope=pc.scope,
            agent_name=agent_name,
            expires=time.time() + SESSION_TTL,
        )
        sessions[session_id] = session
    browser = browsers.get(pc.browser_id)
    if browser and browser.ws:
        try:
            await browser.ws.send_text(json.dumps({
                "action": "session_claimed",
                "session_id": session_id,
                "agent_name": agent_name,
                "scope": pc.scope,
            }))
        except Exception:
            pass
    return {
        "session_id": session_id,
        "session_token": session_token,
        "browser_id": pc.browser_id,
        "scope": pc.scope,
        "expires_in": SESSION_TTL,
    }


# ---------------------------------------------------------------------------
# HTTP: agent-facing command API
# ---------------------------------------------------------------------------

async def _send_and_wait(browser_id: str, cmd_type: str, params: dict, session: Session | None, timeout: float = 30.0) -> dict:
    """Queue a command for the browser and wait for the result."""
    browser = browsers.get(browser_id)
    if not browser or not browser.ws:
        raise HTTPException(503, "Browser not connected")

    params = _apply_scope(session, cmd_type, params)

    cmd_id = uuid.uuid4().hex[:8]
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    agent = _agent_payload(session)
    command_payload = {"type": cmd_type, **params}
    if agent:
        command_payload["_agent"] = agent
    cmd = PendingCommand(cmd_id=cmd_id, payload=command_payload, future=future, session_id=session.session_id if session else None)

    async with _lock:
        pending_commands.setdefault(browser_id, {})[cmd_id] = cmd

    ws_payload = {"id": cmd_id, **command_payload}
    try:
        await browser.ws.send_text(json.dumps(ws_payload))
    except Exception:
        async with _lock:
            pending_commands.get(browser_id, {}).pop(cmd_id, None)
        raise HTTPException(503, "Failed to send command to browser")

    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        async with _lock:
            pending_commands.get(browser_id, {}).pop(cmd_id, None)
        raise HTTPException(408, "Command timed out")
    finally:
        async with _lock:
            pending_commands.get(browser_id, {}).pop(cmd_id, None)

    if result.get("error"):
        return JSONResponse({"error": result["error"]}, status_code=500)
    return {"result": result.get("result")}


@app.post("/cmd")
async def cmd(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    cmd_type = body.pop("type", None)
    if not cmd_type:
        raise HTTPException(400, "type is required")
    timeout = float(body.pop("_timeout", 30))
    return await _send_and_wait(browser_id, cmd_type, body, session, timeout)


# ---------------------------------------------------------------------------
# HTTP: legacy convenience endpoints (all auth-gated)
# ---------------------------------------------------------------------------

@app.post("/navigate")
async def navigate(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    url = body.get("url", "")
    if not url:
        raise HTTPException(400, "url is required")
    kwargs = {"url": url}
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    return await _send_and_wait(browser_id, "navigate", kwargs, session)


@app.post("/execute")
async def execute(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    script = body.get("script", "")
    if not script:
        raise HTTPException(400, "script is required")
    kwargs = {"script": script}
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    if body.get("world"):
        kwargs["world"] = body["world"]
    return await _send_and_wait(browser_id, "execute", kwargs, session)


@app.post("/click")
async def click(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    kwargs = {"selector": body.get("selector", ""), "index": body.get("index", 0)}
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    return await _send_and_wait(browser_id, "click", kwargs, session)


@app.post("/query")
async def query_elements(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    kwargs = {"selector": body.get("selector", ""), "limit": body.get("limit", 50)}
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    return await _send_and_wait(browser_id, "query", kwargs, session)


@app.post("/scroll")
async def scroll(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    kwargs = {
        "selector": body.get("selector", "window"),
        "direction": body.get("direction", "down"),
    }
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    return await _send_and_wait(browser_id, "scroll", kwargs, session)


@app.post("/press")
async def press(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    kwargs = {"key": body.get("key", "")}
    if body.get("tabId"):
        kwargs["tabId"] = body["tabId"]
    return await _send_and_wait(browser_id, "press", kwargs, session)


@app.post("/close")
async def close_tab(
    body: dict,
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    tab_id = body.get("tabId")
    if not tab_id:
        raise HTTPException(400, "tabId is required")
    return await _send_and_wait(browser_id, "closeTab", {"tabId": tab_id}, session)


@app.get("/tabs")
async def tabs(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    return await _send_and_wait(browser_id, "tabs", {}, session)


@app.get("/focused")
async def focused(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    return await _send_and_wait(browser_id, "focused", {}, session)


@app.get("/screenshot")
async def screenshot(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
    windowId: int | None = None,
    tabId: int | None = None,
    format: str | None = None,
):
    kwargs = {}
    if tabId is not None:
        kwargs["tabId"] = tabId
    if windowId is not None:
        kwargs["windowId"] = windowId
    if format:
        kwargs["format"] = format
    return await _send_and_wait(browser_id, "screenshot", kwargs, session)


@app.get("/windows")
async def windows(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    return await _send_and_wait(browser_id, "getWindows", {}, session)


@app.get("/groups")
async def groups(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
    windowId: int | None = None,
):
    kwargs = {}
    if windowId is not None:
        kwargs["queryInfo"] = {"windowId": windowId}
    return await _send_and_wait(browser_id, "queryGroups", kwargs, session)


@app.get("/history")
async def history(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
    q: str = "",
    maxResults: int = 100,
    startTime: float | None = None,
):
    kwargs: dict = {"query": q, "maxResults": maxResults}
    if startTime is not None:
        kwargs["startTime"] = startTime
    return await _send_and_wait(browser_id, "searchHistory", kwargs, session)


@app.get("/bookmarks")
async def bookmarks(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
    q: str = "",
):
    return await _send_and_wait(browser_id, "searchBookmarks", {"query": q}, session)


@app.get("/bookmark_tree")
async def bookmark_tree(
    session: Session | None = Depends(_get_session),
    browser_id: str = Depends(_get_browser_id),
):
    return await _send_and_wait(browser_id, "getBookmarkTree", {}, session)


# ---------------------------------------------------------------------------
# HTTP: status & info
# ---------------------------------------------------------------------------

LLMS_TXT = """# Carrot Browser Bridge

Carrot is a hosted bridge between AI agents and a user's Chrome browser.
The hosted service is available at https://browser.carrotlabs.ai.

What it does:
- Browser extensions connect to /ws over WebSocket.
- Agents call HTTP endpoints or the MCP endpoint at /mcp.
- Users authorize agents with short-lived pairing codes from the Carrot side panel.
- Sessions can be scoped to one tab, one window, or the whole browser.

How an agent should use it:
1. Ask the user to install/open the Carrot Chrome extension and generate a pairing code.
2. Claim the code with POST /sessions/claim and your agent name:
   {"code":"ABC123","agent_name":"your-agent-name"}
3. Use the returned session_token as Authorization: Bearer SESSION_TOKEN.
4. Prefer POST /cmd for browser actions. Example:
   {"type":"readPage"}
5. For page interactions, call readPage or find first and use returned ref IDs.
6. MCP clients can connect directly to https://browser.carrotlabs.ai/mcp and use claim_session.

Useful endpoints:
- GET /status
- POST /sessions/claim
- GET /sessions
- POST /cmd
- GET /focused
- GET /tabs
- GET /windows
- GET /screenshot?tabId=123
- POST /navigate
- POST /execute
- /mcp (MCP endpoint)

Common commands via POST /cmd:
- readPage, find, getPageText, query
- click, hover, type, formInput, scroll, press
- navigate, goBack, goForward
- tabs, focused, getWindows
- screenshot
- readConsole, readNetwork

Self-hosting:
The bridge server is open source in this repository. Users can run their own
server.py locally or run it elsewhere, then set the extension Server URL to
their server instead of https://browser.carrotlabs.ai.
"""


@app.get("/llms.txt", response_class=PlainTextResponse)
async def llms_txt():
    return LLMS_TXT


def _privacy_markdown() -> str:
    return (Path(__file__).with_name("PRIVACY.md")).read_text(encoding="utf-8")


@app.get("/privacy", response_class=HTMLResponse)
async def privacy():
    policy = html.escape(_privacy_markdown())
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carrot Browser Privacy Policy</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #fafafa;
      --card: #ffffff;
      --text: #121212;
      --muted: #5f5f64;
      --border: rgba(15, 15, 15, 0.1);
      --gold: #a67e00;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #090909;
        --card: #111111;
        --text: #f5f5f5;
        --muted: #a8a8a8;
        --border: rgba(255, 255, 255, 0.1);
        --gold: #facd2a;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 32px 18px 64px;
    }}
    main {{
      width: min(860px, 100%);
      margin: 0 auto;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--card);
      padding: clamp(22px, 5vw, 44px);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.08);
    }}
    nav {{
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 28px;
    }}
    a {{
      color: var(--gold);
      text-decoration: none;
      font-weight: 600;
    }}
    a:hover {{ text-decoration: underline; }}
    pre {{
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: inherit;
      color: var(--text);
    }}
    code {{
      color: var(--gold);
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }}
  </style>
</head>
<body>
  <main>
    <nav aria-label="Policy links">
      <a href="https://github.com/carrotlabsai/carrot-browser/blob/main/PRIVACY.md">Open-source policy source</a>
      <a href="https://github.com/carrotlabsai/carrot-browser">GitHub repository</a>
      <a href="/">Bridge status</a>
    </nav>
    <pre>{policy}</pre>
  </main>
</body>
</html>"""


@app.get("/privacy.md", response_class=PlainTextResponse)
async def privacy_markdown():
    return _privacy_markdown()


async def _public_stats() -> dict[str, Any]:
    now = time.time()
    async with _lock:
        browsers_online = sum(1 for b in browsers.values() if b.ws is not None)
        agents_browsing_now = len(sessions)
        pending = sum(len(cmds) for cmds in pending_commands.values())
        scope_counts = {"tab": 0, "window": 0, "browser": 0}
        for session in sessions.values():
            kind = session.scope.partition(":")[0] or "browser"
            scope_counts[kind if kind in scope_counts else "browser"] += 1
    return {
        "ok": True,
        "service": "carrot-browser-bridge",
        "hosted_bridge": "https://browser.carrotlabs.ai",
        "connected": browsers_online > 0,
        "browsers_online": browsers_online,
        "agents_browsing_now": agents_browsing_now,
        "pending_commands": pending,
        "session_scopes": scope_counts,
        "uptime_seconds": int(now - SERVICE_STARTED_AT),
        "auth_required": not NO_AUTH,
        "mcp_endpoint": "/mcp",
        "llms_txt": "/llms.txt",
        "privacy_policy": "/privacy",
    }


@app.get("/", response_class=HTMLResponse)
async def root():
    stats = await _public_stats()
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carrot Browser Bridge</title>
  <style>
    :root {{
      color-scheme: dark;
      --gold: #facd2a;
      --bg: #090909;
      --card: #141414;
      --muted: #a3a3a3;
      --text: #f5f5f5;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 20% 15%, rgba(250, 205, 42, 0.16), transparent 28rem),
        radial-gradient(circle at 80% 85%, rgba(250, 205, 42, 0.08), transparent 24rem),
        var(--bg);
      color: var(--text);
      font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      padding: 32px;
    }}
    main {{
      width: min(760px, 100%);
      border: 1px solid rgba(250, 205, 42, 0.24);
      border-radius: 28px;
      background: rgba(20, 20, 20, 0.86);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      padding: 34px;
    }}
    .eyebrow {{
      color: var(--gold);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }}
    h1 {{
      margin: 10px 0 8px;
      font-size: clamp(36px, 8vw, 64px);
      line-height: 1;
      letter-spacing: -0.05em;
    }}
    p {{ color: var(--muted); margin: 0 0 24px; }}
    .stats {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin: 26px 0;
    }}
    .stat {{
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.035);
      padding: 16px;
    }}
    .value {{ font-size: 34px; font-weight: 800; color: var(--gold); }}
    .label {{ color: var(--muted); font-size: 13px; }}
    .links {{ display: flex; flex-wrap: wrap; gap: 10px; }}
    a {{
      color: var(--text);
      text-decoration: none;
      border: 1px solid rgba(250, 205, 42, 0.28);
      border-radius: 999px;
      padding: 10px 14px;
      background: rgba(250, 205, 42, 0.08);
    }}
    a:hover {{ border-color: var(--gold); }}
    code {{ color: var(--gold); }}
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Carrot Labs</div>
    <h1>Browser Bridge</h1>
    <p>
      A public bridge for pairing AI agents with a user's Chrome browser.
      Agents need a user-generated pairing code before they can browse.
    </p>
    <section class="stats" aria-label="Anonymous live stats">
      <div class="stat">
        <div class="value">{stats["agents_browsing_now"]}</div>
        <div class="label">agents browsing right now</div>
      </div>
      <div class="stat">
        <div class="value">{stats["browsers_online"]}</div>
        <div class="label">browsers online</div>
      </div>
      <div class="stat">
        <div class="value">{stats["pending_commands"]}</div>
        <div class="label">commands in flight</div>
      </div>
    </section>
    <p>
      For agents: start with <code>/llms.txt</code>.
    </p>
    <nav class="links" aria-label="Service links">
      <a href="/llms.txt">llms.txt</a>
      <a href="/status">status JSON</a>
      <a href="/privacy">privacy policy</a>
      <a href="/mcp">MCP endpoint</a>
      <a href="https://carrotlabs.ai">Carrot Labs</a>
    </nav>
  </main>
</body>
</html>"""


@app.get("/status")
async def status():
    return await _public_stats()


@app.get("/sessions")
async def list_sessions(session: Session | None = Depends(_get_session)):
    """List active sessions (agent-facing, requires auth unless no-auth mode)."""
    async with _lock:
        result = []
        for s in sessions.values():
            can_see = (
                session is None
                or (session.scope == "browser" and s.browser_id == session.browser_id)
                or s.session_id == session.session_id
            )
            if can_see:
                result.append({
                    "session_id": s.session_id,
                    "agent_name": s.agent_name,
                    "scope": s.scope,
                    "browser_id": s.browser_id,
                    "created": s.created,
                    "expires": s.expires,
                })
    return {"sessions": result}


# ---------------------------------------------------------------------------
# Backward-compat: /poll and /complete for extensions that haven't upgraded to WS
# ---------------------------------------------------------------------------

@app.get("/poll")
async def poll():
    """Legacy polling endpoint. Returns pending commands for all browsers (no-auth mode only)."""
    if not NO_AUTH:
        raise HTTPException(403, "Polling not available in auth mode. Use WebSocket at /ws")
    all_pending = []
    async with _lock:
        for bid, cmds in pending_commands.items():
            for cid, cmd in cmds.items():
                if not cmd.future.done():
                    all_pending.append({"id": cid, **cmd.payload})
    return {"commands": all_pending}


@app.post("/complete")
async def complete(body: dict):
    """Legacy completion endpoint for non-WS extensions."""
    cmd_id = body.get("id")
    if not cmd_id:
        raise HTTPException(400, "id required")
    async with _lock:
        for bid, cmds in pending_commands.items():
            cmd = cmds.get(cmd_id)
            if cmd and not cmd.future.done():
                cmd.future.set_result({
                    "result": body.get("result"),
                    "error": body.get("error"),
                })
                return {"ok": True}
    return {"ok": False, "error": "command not found"}


@app.post("/ping")
async def ping(body: dict):
    return {"ok": True}


# ---------------------------------------------------------------------------
# MCP server (mounted at /mcp, tools call internal functions directly)
# ---------------------------------------------------------------------------

mcp_server = FastMCP(
    "carrot",
    stateless_http=True,
    json_response=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    instructions=(
        "Carrot controls the user's Chrome browser. "
        "Always call read_page before interacting with elements — you need ref IDs. "
        "Use ref IDs (e.g. ref_42) from read_page/find results for click, type, form_input, etc. "
        "Most commands target the active tab by default; pass tab_id to target a specific tab. "
        "If the server requires authentication, use claim_session with a pairing code first."
    ),
)

_mcp_session_token: str = ""


async def _mcp_resolve() -> tuple[Session | None, str]:
    """Resolve session + browser_id for MCP tool calls."""
    if NO_AUTH:
        connected = [bid for bid, b in browsers.items() if b.ws is not None]
        if not connected:
            raise ValueError("No browser connected")
        return None, connected[0]
    if not _mcp_session_token:
        raise ValueError("Not authenticated. Call claim_session first with a pairing code from the Carrot side panel.")
    token_h = _hash(_mcp_session_token)
    async with _lock:
        for s in sessions.values():
            if s.token_hash == token_h:
                if s.expires > 0 and time.time() > s.expires:
                    raise ValueError("Session expired. Get a new pairing code.")
                return s, s.browser_id
    raise ValueError("Invalid session. Call claim_session with a new pairing code.")


async def _mcp_cmd(type_: str, timeout: float = 30.0, **kwargs) -> dict:
    """Send a command to the browser and return the result (for MCP tools)."""
    session, browser_id = await _mcp_resolve()
    browser = browsers.get(browser_id)
    if not browser or not browser.ws:
        raise ValueError("Browser not connected")
    try:
        kwargs = _apply_scope(session, type_, kwargs)
    except HTTPException as exc:
        raise ValueError(str(exc.detail)) from exc

    cmd_id = uuid.uuid4().hex[:8]
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    agent = _agent_payload(session)
    command_payload = {"type": type_, **kwargs}
    if agent:
        command_payload["_agent"] = agent
    cmd = PendingCommand(cmd_id=cmd_id, payload=command_payload, future=future, session_id=session.session_id if session else None)
    async with _lock:
        pending_commands.setdefault(browser_id, {})[cmd_id] = cmd

    try:
        await browser.ws.send_text(json.dumps({"id": cmd_id, **command_payload}))
    except Exception:
        async with _lock:
            pending_commands.get(browser_id, {}).pop(cmd_id, None)
        raise ValueError("Failed to send command to browser")

    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    except asyncio.TimeoutError:
        raise ValueError("Command timed out")
    finally:
        async with _lock:
            pending_commands.get(browser_id, {}).pop(cmd_id, None)

    if result.get("error"):
        raise ValueError(result["error"])
    return result.get("result", result)


# --- MCP tools ---

@mcp_server.tool()
async def claim_session(code: str, agent_name: str = "mcp-agent") -> str:
    """Claim a session using a pairing code from the Carrot side panel.
    The user generates a 6-character code and gives it to you. Call this first."""
    global _mcp_session_token
    code_str = code.upper().strip()
    async with _lock:
        pc = pairing_codes.get(code_str)
        if not pc or pc.claimed or time.time() > pc.expires:
            return "Invalid or expired pairing code. Ask the user for a new one."
        pc.claimed = True
        session_id = uuid.uuid4().hex[:16]
        session_token = secrets.token_urlsafe(32)
        s = Session(
            session_id=session_id,
            token_hash=_hash(session_token),
            browser_id=pc.browser_id,
            scope=pc.scope,
            agent_name=agent_name,
            expires=time.time() + SESSION_TTL,
        )
        sessions[session_id] = s
    _mcp_session_token = session_token
    browser = browsers.get(pc.browser_id)
    if browser and browser.ws:
        try:
            await browser.ws.send_text(json.dumps({
                "action": "session_claimed", "session_id": session_id,
                "agent_name": agent_name, "scope": pc.scope,
            }))
        except Exception:
            pass
    return f"Session claimed. scope={pc.scope}, expires_in={SESSION_TTL}s."


@mcp_server.tool()
async def read_page(selector: str = "body", max_elements: int = 500, tab_id: int | None = None) -> str:
    """Read the accessibility tree of the current page. Returns elements with ref IDs.
    ALWAYS call this before interacting with page elements."""
    kwargs: dict = {"selector": selector, "maxElements": max_elements}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("readPage", **kwargs))


@mcp_server.tool()
async def find(query: str, role: str | None = None, limit: int = 15, tab_id: int | None = None) -> str:
    """Search for elements by text content, aria-label, or placeholder. Returns ref IDs."""
    kwargs: dict = {"query": query, "limit": limit}
    if role:
        kwargs["role"] = role
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("find", **kwargs))


@mcp_server.tool()
async def get_page_text(selector: str = "body", max_length: int = 500000, tab_id: int | None = None) -> str:
    """Extract the full text content from the page."""
    kwargs: dict = {"selector": selector, "maxLength": max_length}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("getPageText", **kwargs))


@mcp_server.tool()
async def css_query(selector: str, limit: int = 50, tab_id: int | None = None) -> str:
    """Query elements by CSS selector. Returns refs and text content."""
    kwargs: dict = {"selector": selector, "limit": limit}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("query", **kwargs))


@mcp_server.tool()
async def click_element(ref: str | None = None, selector: str | None = None, index: int = 0, tab_id: int | None = None) -> str:
    """Click an element. Prefer ref (from read_page) over selector."""
    kwargs: dict = {}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    kwargs["index"] = index
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("click", **kwargs))


@mcp_server.tool()
async def hover(ref: str | None = None, selector: str | None = None, tab_id: int | None = None) -> str:
    """Hover over an element to trigger hover states or tooltips."""
    kwargs: dict = {}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("hover", **kwargs))


@mcp_server.tool()
async def type_text(text: str, ref: str | None = None, selector: str | None = None, tab_id: int | None = None) -> str:
    """Type text into an element via simulated keyboard input."""
    kwargs: dict = {"text": text}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("type", **kwargs))


@mcp_server.tool()
async def form_input(value: str, ref: str | None = None, selector: str | None = None, tab_id: int | None = None) -> str:
    """Set a form field value directly. Works with select, checkbox, radio, input, textarea, contenteditable."""
    kwargs: dict = {"value": value}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("formInput", **kwargs))


@mcp_server.tool()
async def fill_content_editable(text: str, ref: str | None = None, selector: str | None = None, max_scrolls: int = 24, tab_id: int | None = None) -> str:
    """Fill a rich text / contenteditable element (Gmail compose, Slack, etc.)."""
    kwargs: dict = {"text": text, "maxScrolls": max_scrolls}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("fillContentEditable", **kwargs))


@mcp_server.tool()
async def scroll_page(direction: str = "down", amount: int | None = None, ref: str | None = None, selector: str | None = None, tab_id: int | None = None) -> str:
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
    return str(await _mcp_cmd("scroll", **kwargs))


@mcp_server.tool()
async def press_key(key: str, ref: str | None = None, selector: str | None = None, tab_id: int | None = None) -> str:
    """Send a keyboard key press (Enter, Tab, Escape, ArrowDown, etc.)."""
    kwargs: dict = {"key": key}
    if ref:
        kwargs["ref"] = ref
    if selector:
        kwargs["selector"] = selector
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("press", **kwargs))


@mcp_server.tool()
async def navigate_to(url: str, tab_id: int | None = None) -> str:
    """Navigate the active tab (or a specific tab) to a URL."""
    kwargs: dict = {"url": url}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("navigate", **kwargs))


@mcp_server.tool()
async def go_back(tab_id: int | None = None) -> str:
    """Go back in browser history."""
    kwargs: dict = {}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("goBack", **kwargs))


@mcp_server.tool()
async def go_forward(tab_id: int | None = None) -> str:
    """Go forward in browser history."""
    kwargs: dict = {}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("goForward", **kwargs))


@mcp_server.tool()
async def list_tabs() -> str:
    """List all open browser tabs with their IDs, titles, and URLs."""
    return str(await _mcp_cmd("tabs"))


@mcp_server.tool()
async def focused_tab() -> str:
    """Get the active tab in the last-focused window."""
    return str(await _mcp_cmd("focused"))


@mcp_server.tool()
async def create_tab(url: str | None = None, active: bool = True, tab_id: int | None = None) -> str:
    """Create a new browser tab."""
    kwargs: dict = {"active": active}
    if url:
        kwargs["url"] = url
    return str(await _mcp_cmd("createTab", **kwargs))


@mcp_server.tool()
async def close_browser_tab(tab_id: int) -> str:
    """Close a specific tab by ID."""
    return str(await _mcp_cmd("closeTab", tabId=tab_id))


@mcp_server.tool()
async def reload_tab(tab_id: int | None = None, bypass_cache: bool = False) -> str:
    """Reload a tab. Optionally bypass cache."""
    kwargs: dict = {"bypassCache": bypass_cache}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("reloadTab", **kwargs))


@mcp_server.tool()
async def take_screenshot(window_id: int | None = None, tab_id: int | None = None) -> str:
    """Capture a screenshot. Pass tab_id to target a specific tab."""
    kwargs: dict = {}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    if window_id is not None:
        kwargs["windowId"] = window_id
    return str(await _mcp_cmd("screenshot", **kwargs))


@mcp_server.tool()
async def execute_js(script: str, tab_id: int | None = None) -> str:
    """Execute JavaScript in the page. May fail on Trusted Types sites.
    Prefer read_page + click/type for standard interaction."""
    kwargs: dict = {"script": script}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("execute", **kwargs))


@mcp_server.tool()
async def read_console(install: bool = True, tab_id: int | None = None) -> str:
    """Read console log/warn/error messages from the page."""
    kwargs: dict = {"install": install}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("readConsole", **kwargs))


@mcp_server.tool()
async def read_network(install: bool = True, tab_id: int | None = None) -> str:
    """Read network requests (fetch/XHR) with status codes from the page."""
    kwargs: dict = {"install": install}
    if tab_id is not None:
        kwargs["tabId"] = tab_id
    return str(await _mcp_cmd("readNetwork", **kwargs))


@mcp_server.tool()
async def search_history(query: str = "", max_results: int = 100) -> str:
    """Search browser history."""
    return str(await _mcp_cmd("searchHistory", query=query, maxResults=max_results))


@mcp_server.tool()
async def search_bookmarks(query: str = "") -> str:
    """Search bookmarks by query string."""
    return str(await _mcp_cmd("searchBookmarks", query=query))


@mcp_server.tool()
async def server_status() -> str:
    """Check if the bridge server is running and a browser is connected."""
    async with _lock:
        n_browsers = sum(1 for b in browsers.values() if b.ws is not None)
        n_sessions = len(sessions)
    return f"browsers={n_browsers}, sessions={n_sessions}, auth_required={not NO_AUTH}"


# Streamable HTTP MCP endpoint (stateless transport)
_mcp_session_mgr = StreamableHTTPSessionManager(
    app=mcp_server._mcp_server,
    json_response=True,
    stateless=True,
    security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)
_mcp_asgi = StreamableHTTPASGIApp(_mcp_session_mgr)

app.add_route("/mcp", _mcp_asgi, methods=["GET", "POST", "DELETE"])


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="Carrot Bridge Server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CARROT_PORT", "8080")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--no-auth", action="store_true", help="Disable authentication (local dev)")
    args = parser.parse_args()

    if args.no_auth:
        global NO_AUTH
        NO_AUTH = True

    bind = "127.0.0.1" if NO_AUTH else args.host

    print(f"🥕 Carrot Bridge Server")
    print(f"   Mode: {'LOCAL (no auth)' if NO_AUTH else 'CLOUD (auth required)'}")
    print(f"   Listening on {bind}:{args.port}")
    if NO_AUTH:
        print(f"   ⚠️  Auth disabled — only use on localhost")
    print()

    uvicorn.run(app, host=bind, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
