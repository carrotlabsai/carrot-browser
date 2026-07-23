// ---------------------------------------------------------------------------
// Carrot Extension — Background Service Worker
//
// Connects to the Carrot Bridge Server via WebSocket (cloud/auth mode) or
// HTTP polling (legacy local mode). Executes browser commands from agents.
// Tracks per-tab control state and streams activity to the side panel + an
// on-page overlay so the user always knows when an agent is acting.
// ---------------------------------------------------------------------------

const DEFAULT_SERVER = "https://browser.carrotlabs.ai";
const STORAGE_KEY_SERVER = "carrot_server_url";
const STORAGE_KEY_BROWSER_ID = "carrot_browser_id";
const STORAGE_KEY_BROWSER_TOKEN = "carrot_browser_token";
const STORAGE_KEY_USE_WS = "carrot_use_ws";

let connected = false;
let ws = null;
let serverUrl = DEFAULT_SERVER;
let browserId = "";
let browserToken = "";
let useWs = true;

// Tracks which tabs are currently under agent control:
// tabId -> { lastActivity: number, windowId: number }
const controlledTabs = new Map();
const TAB_CONTROL_TIMEOUT_MS = 8000;
let activitySeq = 0;

// ---------------------------------------------------------------------------
// Initialization: load config from storage, then connect
// `initPromise` lets every other entry point (alarms, runtime listeners) await
// initialization before touching network state. Without this, a freshly-woken
// service worker can fire connectWebSocket() with empty creds.
// ---------------------------------------------------------------------------

let initPromise = null;

function ready() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

async function init() {
  const data = await chrome.storage.local.get([
    STORAGE_KEY_SERVER, STORAGE_KEY_BROWSER_ID, STORAGE_KEY_BROWSER_TOKEN, STORAGE_KEY_USE_WS,
  ]);
  serverUrl = data[STORAGE_KEY_SERVER] || DEFAULT_SERVER;
  useWs = data[STORAGE_KEY_USE_WS] !== false;

  if (!data[STORAGE_KEY_BROWSER_ID]) {
    browserId = crypto.randomUUID();
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    browserToken = btoa(String.fromCharCode(...tokenBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await chrome.storage.local.set({
      [STORAGE_KEY_BROWSER_ID]: browserId,
      [STORAGE_KEY_BROWSER_TOKEN]: browserToken,
    });
  } else {
    browserId = data[STORAGE_KEY_BROWSER_ID];
    browserToken = data[STORAGE_KEY_BROWSER_TOKEN];
  }

  if (useWs) {
    connectWebSocket();
  } else {
    schedulePoll(0);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY_SERVER] || changes[STORAGE_KEY_USE_WS]) {
    chrome.storage.local.get([STORAGE_KEY_SERVER, STORAGE_KEY_USE_WS], (data) => {
      const newUrl = data[STORAGE_KEY_SERVER] || DEFAULT_SERVER;
      const newUseWs = data[STORAGE_KEY_USE_WS] !== false;
      if (newUrl !== serverUrl || newUseWs !== useWs) {
        serverUrl = newUrl;
        useWs = newUseWs;
        disconnect();
        if (useWs) {
          connectWebSocket();
        } else {
          schedulePoll(0);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

let wsReconnectDelay = 1000;
let wsReconnectTimerId = null;

function getWsUrl() {
  let base = serverUrl.replace(/\/+$/, "");
  if (base.startsWith("https://")) {
    base = "wss://" + base.slice(8);
  } else if (base.startsWith("http://")) {
    base = "ws://" + base.slice(7);
  }
  return `${base}/ws?browser_id=${encodeURIComponent(browserId)}&browser_token=${encodeURIComponent(browserToken)}`;
}

function connectWebSocket() {
  // Guard: never attempt a connection until init has populated credentials.
  // Without this, a service-worker wake-up can fire this from an alarm before
  // storage has been read, producing ws://…?browser_id=&browser_token=
  if (!browserId || !browserToken) {
    ready().then(() => {
      if (useWs) connectWebSocket();
    });
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearWsReconnectTimer();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  let socket;
  try {
    socket = new WebSocket(getWsUrl());
    ws = socket;
  } catch {
    connected = false;
    scheduleWsReconnect();
    return;
  }

  socket.onopen = () => {
    if (ws !== socket) return;
    connected = true;
    wsReconnectDelay = 1000;
    clearWsReconnectTimer();
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    try {
      const msg = JSON.parse(event.data);
      if (msg.action) {
        // Server-to-extension messages (pairing responses, etc.) — forward to popup
        chrome.runtime.sendMessage(msg).catch(() => {});
      } else if (msg.type) {
        handleCommand(msg);
      }
    } catch {}
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    connected = false;
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    connected = false;
    ws = null;
    scheduleWsReconnect();
  };
}

function clearWsReconnectTimer() {
  if (wsReconnectTimerId !== null) {
    clearTimeout(wsReconnectTimerId);
    wsReconnectTimerId = null;
  }
}

function scheduleWsReconnect() {
  if (!useWs) return;
  if (wsReconnectTimerId !== null) return;
  wsReconnectTimerId = setTimeout(() => {
    wsReconnectTimerId = null;
    connectWebSocket();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
}

function disconnect() {
  clearWsReconnectTimer();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  connected = false;
  if (pollTimeoutId !== null) {
    clearTimeout(pollTimeoutId);
    pollTimeoutId = null;
  }
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Legacy HTTP polling (for --no-auth local mode)
// ---------------------------------------------------------------------------

let pollTimeoutId = null;

function schedulePoll(delay) {
  if (pollTimeoutId !== null) clearTimeout(pollTimeoutId);
  pollTimeoutId = setTimeout(poll, delay);
}

async function poll() {
  pollTimeoutId = null;
  if (useWs) return;
  try {
    const resp = await fetch(`${serverUrl}/poll`);
    const { commands } = await resp.json();
    connected = true;
    for (const cmd of commands || []) {
      handleCommand(cmd);
    }
    schedulePoll(1000);
  } catch {
    connected = false;
    schedulePoll(5000);
  }
}

function completeViaHttp(id, result, error) {
  fetch(`${serverUrl}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, result, error }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Alarm-based backup (keep service worker alive)
// ---------------------------------------------------------------------------

ready();

// Make the toolbar icon open the side panel (primary UI).
try {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch(() => {});
} catch {}

chrome.alarms.create("carrot", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async () => {
  await ready();
  if (useWs && (!ws || ws.readyState !== WebSocket.OPEN)) {
    connectWebSocket();
  } else if (!useWs && pollTimeoutId === null) {
    poll();
  }
});
chrome.runtime.onInstalled.addListener(() => ready());
chrome.runtime.onStartup.addListener(() => ready());

// ---------------------------------------------------------------------------
// Message passing (from popup / options pages)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get_status") {
    sendResponse({
      connected,
      serverUrl,
      browserId,
      useWs,
      wsState: ws?.readyState,
    });
    return false;
  }

  if (msg.type === "create_pairing") {
    const ok = sendToServer({
      action: "create_pairing",
      scope: msg.scope || "browser",
    });
    sendResponse({ sent: ok });
    return false;
  }

  if (msg.type === "list_sessions") {
    const ok = sendToServer({ action: "list_sessions" });
    sendResponse({ sent: ok });
    return false;
  }

  if (msg.type === "revoke_session") {
    const ok = sendToServer({
      action: "revoke_session",
      session_id: msg.session_id,
    });
    sendResponse({ sent: ok });
    return false;
  }

  if (msg.type === "reconnect") {
    disconnect();
    if (useWs) connectWebSocket();
    else schedulePoll(0);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function getFocusedTabContext(cmd = {}) {
  if (cmd.tabId) {
    const tab = await chrome.tabs.get(cmd.tabId);
    return tabContextFromTab(tab);
  }
  const win = cmd.windowId
    ? await chrome.windows.get(cmd.windowId, { populate: true, windowTypes: ["normal"] })
    : await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
  if (!win?.tabs?.length) throw new Error("No focused window");
  const tab = win.tabs.find((t) => t.active);
  if (!tab?.id) throw new Error("No active tab");
  return tabContextFromTab(tab);
}

function tabContextFromTab(tab) {
  const id = tab.id;
  return {
    tabId: id,
    windowId: tab.windowId,
    title: tab.title || "",
    url: tab.url || "",
    carrotId: `tab-${id}`,
    agentHint: `Use tabId ${id} in Carrot bridge JSON (e.g. {"tabId": ${id}, "script": "..."} for POST /execute).`,
  };
}

function summarizeTab(tab) {
  return {
    id: tab.id, url: tab.url, title: tab.title,
    active: tab.active, windowId: tab.windowId,
    pinned: tab.pinned, groupId: tab.groupId,
  };
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab.id;
}

async function getActiveTabIdInWindow(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) throw new Error("No active tab in scoped window");
  return tab.id;
}

async function captureTabScreenshotWithDebugger(tabId, opts = {}) {
  const target = { tabId };
  const format = opts.format || "png";
  const params = {
    format,
    fromSurface: true,
  };
  if (format !== "png" && opts.quality !== undefined) {
    params.quality = opts.quality;
  }

  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Page.enable");
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
    if (!result?.data) throw new Error("Debugger screenshot returned no data");
    return `data:image/${format};base64,${result.data}`;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {}
    }
  }
}

async function clickTabAt(tabId, x, y, opts = {}) {
  const target = { tabId };
  const button = opts.button || "left";
  const coordinateSpace = opts.coordinateSpace || "page";
  let point = { clientX: Number(x), clientY: Number(y), scrollX: 0, scrollY: 0 };
  if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) {
    throw new Error("clickAt requires numeric x and y");
  }

  if (coordinateSpace !== "viewport") {
    point = await resolvePagePointToViewport(tabId, point.clientX, point.clientY, opts.scrollIntoView !== false);
  }

  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.clientX,
      y: point.clientY,
      button: "none",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.clientX,
      y: point.clientY,
      button,
      buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.clientX,
      y: point.clientY,
      button,
      buttons: 0,
      clickCount: 1,
    });
    return {
      clicked: true,
      tabId,
      x: Number(x),
      y: Number(y),
      clientX: point.clientX,
      clientY: point.clientY,
      coordinateSpace,
      scrollX: point.scrollX,
      scrollY: point.scrollY,
    };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {}
    }
  }
}

async function resolvePagePointToViewport(tabId, x, y, scrollIntoView) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (pageX, pageY, shouldScroll) => {
      if (shouldScroll) {
        const targetX = Math.max(0, pageX - Math.floor(window.innerWidth / 2));
        const targetY = Math.max(0, pageY - Math.floor(window.innerHeight / 2));
        if (
          pageX < window.scrollX ||
          pageX > window.scrollX + window.innerWidth ||
          pageY < window.scrollY ||
          pageY > window.scrollY + window.innerHeight
        ) {
          window.scrollTo({ left: targetX, top: targetY, behavior: "instant" });
        }
      }
      return {
        clientX: pageX - window.scrollX,
        clientY: pageY - window.scrollY,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    },
    args: [x, y, scrollIntoView],
  });
  const point = r?.result;
  if (!point) throw new Error("Unable to resolve clickAt page coordinates");
  return point;
}

// ---------------------------------------------------------------------------
// Activity / tab control broadcasting
// ---------------------------------------------------------------------------

function broadcastActivity(entry) {
  try {
    chrome.runtime.sendMessage({ action: "carrot_activity", entry }).catch(() => {});
  } catch {}
}

function broadcastScopeTab(tab) {
  try {
    chrome.runtime
      .sendMessage({ type: "scope_tab_changed", tab: summarizeTab(tab) })
      .catch(() => {});
  } catch {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    broadcastScopeTab(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!tab.active || (!changeInfo.title && changeInfo.status !== "complete")) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win?.focused) broadcastScopeTab(tab);
  } catch {}
});

async function markTabControlled(tabId, actionLabel) {
  if (!tabId) return;
  let info = controlledTabs.get(tabId);
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (!info) {
    info = { windowId: tab.windowId, lastActivity: Date.now() };
    controlledTabs.set(tabId, info);
    // Auto-open the side panel in the window being controlled so the user can
    // watch what's happening. Ignored if the panel is already open.
    try {
      chrome.sidePanel?.open?.({ windowId: tab.windowId }).catch(() => {});
    } catch {}
  }
  info.lastActivity = Date.now();
  try {
    chrome.tabs
      .sendMessage(tabId, {
        type: "carrot_tab_control",
        active: true,
        label: actionLabel,
      })
      .catch(() => {});
  } catch {}
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, info] of controlledTabs.entries()) {
    if (now - info.lastActivity > TAB_CONTROL_TIMEOUT_MS) {
      controlledTabs.delete(tabId);
      try {
        chrome.tabs
          .sendMessage(tabId, { type: "carrot_tab_control", active: false })
          .catch(() => {});
      } catch {}
    }
  }
}, 2000);

chrome.tabs.onRemoved.addListener((tabId) => controlledTabs.delete(tabId));

const TAB_SCOPE_COMMANDS = new Set([
  "focused", "tabs",
  "navigate", "activateTab", "closeTab", "reloadTab", "pinTab", "muteTab", "discardTab",
  "screenshot", "resolveFrame", "clickAt",
  "readPage", "find", "getPageText", "dom", "query",
  "click", "hover", "type", "formInput", "scroll", "press",
  "fillContentEditable",
  "goBack", "goForward",
  "readConsole", "readNetwork", "execute", "executeInFrame",
]);

const WINDOW_SCOPE_COMMANDS = new Set([
  ...TAB_SCOPE_COMMANDS,
  "getWindows", "createTab", "duplicateTab", "moveTab",
  "groupTabs", "ungroupTabs", "updateGroup", "queryGroups",
  "updateWindow", "closeWindow", "resizeWindow",
  "activateTab",
]);

const TAB_TARGETED_COMMANDS = new Set([
  "navigate", "activateTab", "closeTab", "reloadTab", "pinTab", "muteTab", "discardTab",
  "screenshot", "resolveFrame", "clickAt",
  "readPage", "find", "getPageText", "dom", "query",
  "click", "hover", "type", "formInput", "scroll", "press",
  "fillContentEditable",
  "goBack", "goForward",
  "readConsole", "readNetwork", "execute", "executeInFrame",
]);

async function enforceCommandScope(cmd) {
  const scope = cmd._agent?.scope || "browser";
  if (scope === "browser") return;
  const [kind, rawId] = scope.split(":");
  const scopedId = Number(rawId);
  if (!kind || !Number.isFinite(scopedId)) return;

  if (kind === "tab") {
    if (!TAB_SCOPE_COMMANDS.has(cmd.type)) {
      throw new Error(`Command not allowed for tab scope: ${cmd.type}`);
    }
    if (cmd.tabId && cmd.tabId !== scopedId) {
      throw new Error(`Command outside session scope (${scope})`);
    }
    if (TAB_TARGETED_COMMANDS.has(cmd.type) || cmd.type === "tabs" || cmd.type === "focused") {
      cmd.tabId = scopedId;
      delete cmd.windowId;
    }
    return;
  }

  if (kind === "window") {
    if (!WINDOW_SCOPE_COMMANDS.has(cmd.type)) {
      throw new Error(`Command not allowed for window scope: ${cmd.type}`);
    }
    if (cmd.windowId && cmd.windowId !== scopedId) {
      throw new Error(`Command outside session scope (${scope})`);
    }
    if (cmd.tabId) await assertTabInWindow(cmd.tabId, scopedId, scope);
    if (Array.isArray(cmd.tabIds)) {
      for (const tabId of cmd.tabIds) await assertTabInWindow(tabId, scopedId, scope);
    }
    if (cmd.type === "updateGroup" && cmd.groupId) {
      const group = await chrome.tabGroups.get(cmd.groupId);
      if (group.windowId !== scopedId) throw new Error(`Command outside session scope (${scope})`);
    }
    if (cmd.type === "queryGroups") {
      cmd.queryInfo = { ...(cmd.queryInfo || {}), windowId: scopedId };
    }
    if (!cmd.tabId && (TAB_TARGETED_COMMANDS.has(cmd.type) || cmd.type === "tabs" || cmd.type === "focused")) {
      cmd.windowId = scopedId;
    }
    if (["getWindows", "createTab", "updateWindow", "closeWindow", "resizeWindow"].includes(cmd.type)) {
      cmd.windowId = scopedId;
    }
  }
}

async function assertTabInWindow(tabId, windowId, scope) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== windowId) throw new Error(`Command outside session scope (${scope})`);
}

async function handleCommand(cmd) {
  let result = null;
  let error = null;
  const getTab = async () => cmd.tabId || (cmd.windowId ? await getActiveTabIdInWindow(cmd.windowId) : await getActiveTabId());
  const startedAt = Date.now();

  try {
    await enforceCommandScope(cmd);
    switch (cmd.type) {

      // ===================== Tab info =====================

      case "focused":
        result = await getFocusedTabContext(cmd);
        break;

      case "tabs": {
        if (cmd.tabId) {
          const tab = await chrome.tabs.get(cmd.tabId);
          result = [summarizeTab(tab)];
          break;
        }
        const queryInfo = {};
        if (cmd.windowId) queryInfo.windowId = cmd.windowId;
        result = await chrome.tabs.query(queryInfo).then((tabs) =>
          tabs.map((t) => ({
            id: t.id, url: t.url, title: t.title,
            active: t.active, windowId: t.windowId,
            pinned: t.pinned, groupId: t.groupId,
          }))
        );
        break;
      }

      // ===================== Tab actions (need tabId) =====================

      case "navigate": {
        const tabId = await getTab();
        await chrome.tabs.update(tabId, { url: cmd.url });
        result = { tabId, url: cmd.url };
        break;
      }

      case "activateTab": {
        if (!cmd.tabId) throw new Error("activateTab requires tabId");
        const prev = await chrome.tabs.get(cmd.tabId);
        await chrome.windows.update(prev.windowId, { focused: true });
        const tab = await chrome.tabs.update(cmd.tabId, { active: true });
        result = {
          activated: true,
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          title: tab.title,
        };
        break;
      }

      case "closeTab": {
        const tabId = await getTab();
        await chrome.tabs.remove(tabId);
        result = { closed: true, tabId };
        break;
      }

      case "reloadTab": {
        const tabId = await getTab();
        await chrome.tabs.reload(tabId, { bypassCache: !!cmd.bypassCache });
        result = { reloaded: true, tabId };
        break;
      }

      case "duplicateTab": {
        const tabId = await getTab();
        const newTab = await chrome.tabs.duplicate(tabId);
        result = { tabId: newTab.id, url: newTab.url, title: newTab.title };
        break;
      }

      case "pinTab": {
        const tabId = await getTab();
        const updated = await chrome.tabs.update(tabId, { pinned: cmd.pinned !== false });
        result = { tabId, pinned: updated.pinned };
        break;
      }

      case "muteTab": {
        const tabId = await getTab();
        const updated = await chrome.tabs.update(tabId, { muted: cmd.muted !== false });
        result = { tabId, muted: updated.mutedInfo?.muted };
        break;
      }

      case "moveTab": {
        const tabId = await getTab();
        const props = { index: cmd.index ?? -1 };
        if (cmd.windowId) props.windowId = cmd.windowId;
        const moved = await chrome.tabs.move(tabId, props);
        result = { tabId, index: moved.index, windowId: moved.windowId };
        break;
      }

      case "discardTab": {
        const tabId = await getTab();
        await chrome.tabs.discard(tabId);
        result = { discarded: true, tabId };
        break;
      }

      // ===================== Create tab =====================

      case "createTab": {
        const opts = {};
        if (cmd.url) opts.url = cmd.url;
        if (cmd.active !== undefined) opts.active = cmd.active;
        if (cmd.pinned) opts.pinned = true;
        if (cmd.index !== undefined) opts.index = cmd.index;
        if (cmd.windowId) opts.windowId = cmd.windowId;
        const tab = await chrome.tabs.create(opts);
        result = { tabId: tab.id, url: tab.url, windowId: tab.windowId, index: tab.index };
        break;
      }

      // ===================== Tab groups =====================

      case "groupTabs": {
        const opts = { tabIds: cmd.tabIds };
        if (cmd.groupId) opts.groupId = cmd.groupId;
        const gid = await chrome.tabs.group(opts);
        const updateProps = {};
        if (cmd.title) updateProps.title = cmd.title;
        if (cmd.color) updateProps.color = cmd.color;
        if (cmd.collapsed !== undefined) updateProps.collapsed = cmd.collapsed;
        if (Object.keys(updateProps).length) {
          await chrome.tabGroups.update(gid, updateProps);
        }
        result = { groupId: gid };
        break;
      }

      case "ungroupTabs":
        await chrome.tabs.ungroup(cmd.tabIds);
        result = { ungrouped: true, tabIds: cmd.tabIds };
        break;

      case "updateGroup": {
        const props = {};
        if (cmd.title !== undefined) props.title = cmd.title;
        if (cmd.color) props.color = cmd.color;
        if (cmd.collapsed !== undefined) props.collapsed = cmd.collapsed;
        result = await chrome.tabGroups.update(cmd.groupId, props);
        break;
      }

      case "queryGroups":
        result = await chrome.tabGroups.query(cmd.queryInfo || {});
        break;

      // ===================== Windows =====================

      case "createWindow": {
        const opts = {};
        if (cmd.url) opts.url = cmd.url;
        if (cmd.windowType) opts.type = cmd.windowType;
        if (cmd.state) opts.state = cmd.state;
        if (cmd.incognito) opts.incognito = true;
        if (cmd.focused !== undefined) opts.focused = cmd.focused;
        for (const k of ["left", "top", "width", "height"]) {
          if (cmd[k] !== undefined) opts[k] = cmd[k];
        }
        const win = await chrome.windows.create(opts);
        result = {
          windowId: win.id, state: win.state,
          left: win.left, top: win.top, width: win.width, height: win.height,
          tabs: win.tabs?.map((t) => ({ id: t.id, url: t.url })) || [],
        };
        break;
      }

      case "updateWindow": {
        const props = {};
        if (cmd.state) props.state = cmd.state;
        if (cmd.focused !== undefined) props.focused = cmd.focused;
        if (cmd.drawAttention) props.drawAttention = true;
        for (const k of ["left", "top", "width", "height"]) {
          if (cmd[k] !== undefined) props[k] = cmd[k];
        }
        const win = await chrome.windows.update(cmd.windowId, props);
        result = { windowId: win.id, state: win.state, left: win.left, top: win.top, width: win.width, height: win.height };
        break;
      }

      case "closeWindow":
        await chrome.windows.remove(cmd.windowId);
        result = { closed: true, windowId: cmd.windowId };
        break;

      case "getWindows": {
        const wins = cmd.windowId
          ? [await chrome.windows.get(cmd.windowId, { populate: true, windowTypes: ["normal"] })]
          : await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
        result = wins.map((w) => ({
          windowId: w.id, state: w.state, focused: w.focused,
          left: w.left, top: w.top, width: w.width, height: w.height,
          tabs: w.tabs?.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, pinned: t.pinned, groupId: t.groupId })) || [],
        }));
        break;
      }

      // ===================== Screenshots =====================

      case "screenshot": {
        const format = cmd.format || "png";
        const quality = cmd.quality || 90;
        const dataUrl = cmd.tabId
          ? await captureTabScreenshotWithDebugger(cmd.tabId, { format, quality })
          : await chrome.tabs.captureVisibleTab(cmd.windowId || null, { format, quality });
        result = { dataUrl, format, tabId: cmd.tabId || null };
        break;
      }

      case "resolveFrame": {
        const tabId = await getTab();
        const frame = await resolveFrameId(tabId, cmd.frameSelector || cmd.selector, cmd.frameIndex || cmd.index || 0);
        result = { tabId, ...frame };
        break;
      }

      case "clickAt": {
        const tabId = await getTab();
        result = await clickTabAt(tabId, cmd.x, cmd.y, {
          button: cmd.button,
          coordinateSpace: cmd.coordinateSpace,
          scrollIntoView: cmd.scrollIntoView,
        });
        break;
      }

      // ===================== History =====================

      case "searchHistory":
        result = await chrome.history.search({
          text: cmd.query || "",
          startTime: cmd.startTime || 0,
          endTime: cmd.endTime,
          maxResults: cmd.maxResults || 100,
        });
        break;

      case "deleteHistory":
        await chrome.history.deleteUrl({ url: cmd.url });
        result = { deleted: true, url: cmd.url };
        break;

      // ===================== Bookmarks =====================

      case "searchBookmarks":
        result = await chrome.bookmarks.search(cmd.query || "");
        break;

      case "createBookmark": {
        const opts = { title: cmd.title || "" };
        if (cmd.url) opts.url = cmd.url;
        if (cmd.parentId) opts.parentId = cmd.parentId;
        result = await chrome.bookmarks.create(opts);
        break;
      }

      case "getBookmarkTree":
        result = await chrome.bookmarks.getTree();
        break;

      // ===================== Downloads =====================

      case "download": {
        const opts = { url: cmd.url };
        if (cmd.filename) opts.filename = cmd.filename;
        if (cmd.saveAs) opts.saveAs = true;
        const id = await chrome.downloads.download(opts);
        result = { downloadId: id };
        break;
      }

      case "getDownloads":
        result = await chrome.downloads.search(cmd.queryInfo || {});
        break;

      // ===================== Notifications =====================

      case "notify": {
        const id = await chrome.notifications.create("", {
          type: "basic",
          title: cmd.title || "Carrot",
          message: cmd.message || "",
          iconUrl: cmd.iconUrl || chrome.runtime.getURL("assets/icons/icon-128.png"),
        });
        result = { notificationId: id };
        break;
      }

      // ===================== Page reading & element discovery =====================

      case "readPage": {
        const tabId = await getTab();
        result = await injectReadPage(tabId, cmd.selector || "body", cmd.maxElements || 500);
        break;
      }

      case "find": {
        const tabId = await getTab();
        result = await injectFind(tabId, cmd.query || "", cmd.role, cmd.limit || 15);
        break;
      }

      case "getPageText": {
        const tabId = await getTab();
        result = await injectGetPageText(tabId, cmd.selector || "body", cmd.maxLength || 500000);
        break;
      }

      case "dom": {
        const tabId = await getTab();
        result = await injectGetPageText(tabId, cmd.selector || "body", 500000);
        break;
      }

      case "query": {
        const tabId = await getTab();
        result = await injectQuery(tabId, cmd.selector, cmd.limit || 50);
        break;
      }

      // ===================== Interaction (accept ref OR selector) =====================

      case "click": {
        const tabId = await getTab();
        result = await injectAction(tabId, "click", actionInjectionOptions(cmd));
        break;
      }

      case "hover": {
        const tabId = await getTab();
        result = await injectAction(tabId, "hover", actionInjectionOptions(cmd));
        break;
      }

      case "type": {
        const tabId = await getTab();
        result = await injectAction(tabId, "type", actionInjectionOptions(cmd, { text: cmd.text }));
        break;
      }

      case "formInput": {
        const tabId = await getTab();
        result = await injectAction(tabId, "formInput", actionInjectionOptions(cmd, { value: cmd.value }));
        break;
      }

      case "scroll": {
        const tabId = await getTab();
        result = await injectScroll(tabId, cmd.ref, cmd.selector, cmd.direction || "down", cmd.amount);
        break;
      }

      case "press": {
        const tabId = await getTab();
        result = await injectPress(tabId, cmd.key, cmd.ref, cmd.selector);
        break;
      }

      case "fillContentEditable": {
        const tabId = await getTab();
        result = await injectAction(tabId, "fillContentEditable", actionInjectionOptions(cmd, {
          selector: cmd.selector || "#contenteditable-root",
          text: cmd.text || "", maxScrolls: cmd.maxScrolls ?? 24,
        }));
        break;
      }

      // ===================== Navigation =====================

      case "goBack": {
        const tabId = await getTab();
        await chrome.tabs.goBack(tabId);
        result = { navigated: "back", tabId };
        break;
      }

      case "goForward": {
        const tabId = await getTab();
        await chrome.tabs.goForward(tabId);
        result = { navigated: "forward", tabId };
        break;
      }

      // ===================== Window management =====================

      case "resizeWindow": {
        const wid = cmd.windowId || (await chrome.windows.getLastFocused()).id;
        const props = {};
        if (cmd.width !== undefined) props.width = cmd.width;
        if (cmd.height !== undefined) props.height = cmd.height;
        if (cmd.left !== undefined) props.left = cmd.left;
        if (cmd.top !== undefined) props.top = cmd.top;
        const win = await chrome.windows.update(wid, props);
        result = { windowId: win.id, width: win.width, height: win.height, left: win.left, top: win.top };
        break;
      }

      // ===================== Debug tools =====================

      case "readConsole": {
        const tabId = await getTab();
        result = await injectReadConsole(tabId, cmd.install !== false);
        break;
      }

      case "readNetwork": {
        const tabId = await getTab();
        result = await injectReadNetwork(tabId, cmd.install !== false);
        break;
      }

      // ===================== JS execution =====================

      case "execute":
      case "executeInFrame": {
        const tabId = await getTab();
        result = await injectEval(tabId, cmd.script, cmd.world || "MAIN", frameInjectionOptions(cmd));
        break;
      }

      default:
        error = "Unknown command: " + cmd.type;
    }
  } catch (e) {
    error = String(e);
  }

  // Broadcast activity + tab-control overlay
  try {
    const detail = describeCommand(cmd, result, error);
    const resolvedTabId = await resolveTabIdSafe(cmd);
    const agent = cmd._agent || {};
    broadcastActivity({
      id: ++activitySeq,
      type: cmd.type,
      detail,
      tabId: resolvedTabId || null,
      agentName: agent.agent_name || "",
      sessionId: agent.session_id || "",
      agentScope: agent.scope || "",
      error: error ? String(error) : null,
      ts: startedAt,
      durationMs: Date.now() - startedAt,
    });
    if (resolvedTabId && TAB_INTERACTION_TYPES.has(cmd.type)) {
      await markTabControlled(resolvedTabId, humanizeCmd(cmd));
    }
  } catch {}

  // Send result back
  if (useWs) {
    sendToServer({ action: "complete", id: cmd.id, result, error });
  } else {
    completeViaHttp(cmd.id, result, error);
  }
}

// ---------------------------------------------------------------------------
// Command describe / tab resolution helpers
// ---------------------------------------------------------------------------

const TAB_INTERACTION_TYPES = new Set([
  "click", "hover", "type", "formInput", "scroll", "press",
  "fillContentEditable", "readPage", "find", "getPageText", "dom",
  "query", "navigate", "goBack", "goForward", "reloadTab",
  "screenshot", "resolveFrame", "clickAt", "readConsole", "readNetwork", "execute", "executeInFrame",
]);

async function resolveTabIdSafe(cmd) {
  if (cmd.tabId) return cmd.tabId;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return tab?.id || null;
  } catch {
    return null;
  }
}

function humanizeCmd(cmd) {
  if (cmd.type === "click") return `Click ${cmd.ref || cmd.selector || ""}`;
  if (cmd.type === "type") return `Type "${truncStr(cmd.text, 30)}"`;
  if (cmd.type === "formInput") return `Fill ${cmd.ref || cmd.selector || ""}`;
  if (cmd.type === "navigate") return `Navigate ${truncStr(cmd.url, 40)}`;
  if (cmd.type === "activateTab") return `Activate tab ${cmd.tabId}`;
  if (cmd.type === "press") return `Press ${cmd.key}`;
  if (cmd.type === "scroll") return `Scroll ${cmd.direction || "down"}`;
  if (cmd.type === "screenshot") return "Taking screenshot";
  if (cmd.type === "resolveFrame") return `Resolve frame ${cmd.frameSelector || cmd.selector || ""}`;
  if (cmd.type === "clickAt") return `Click at ${cmd.x},${cmd.y}`;
  if (cmd.type === "readPage") return "Reading page";
  if (cmd.type === "find") return `Find "${truncStr(cmd.query, 30)}"`;
  return cmd.type;
}

function describeCommand(cmd, result, error) {
  if (error) return String(error).slice(0, 160);
  switch (cmd.type) {
    case "click":
    case "hover":
      return cmd.ref ? `ref=${cmd.ref}` : cmd.selector || "";
    case "type":
      return `"${truncStr(cmd.text, 60)}"`;
    case "formInput":
      return `${cmd.ref || cmd.selector || ""} = ${truncStr(String(cmd.value ?? ""), 40)}`;
    case "navigate":
      return truncStr(cmd.url, 80);
    case "press":
      return cmd.key || "";
    case "scroll":
      return `${cmd.direction || "down"}${cmd.amount ? ` · ${cmd.amount}px` : ""}`;
    case "find":
    case "query":
      return truncStr(cmd.query || cmd.selector || "", 60);
    case "readPage":
      return result?.count != null ? `${result.count} elements` : "";
    case "screenshot":
      return result?.format || "png";
    case "resolveFrame":
      return result?.frameId != null ? `frameId=${result.frameId}` : "";
    case "clickAt":
      return `${cmd.x},${cmd.y}`;
    case "createTab":
      return truncStr(cmd.url, 60);
    case "activateTab":
      return `tabId=${cmd.tabId}`;
    case "execute":
    case "executeInFrame":
      return truncStr((cmd.script || "").replace(/\s+/g, " "), 60);
    default:
      return "";
  }
}

function truncStr(s, n) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function actionInjectionOptions(cmd, extra = {}) {
  return {
    ref: cmd.ref,
    selector: cmd.selector,
    index: cmd.index || 0,
    ...frameInjectionOptions(cmd),
    ...extra,
  };
}

function frameInjectionOptions(cmd) {
  const opts = {};
  if (cmd.frameId !== undefined && cmd.frameId !== null) opts.frameId = cmd.frameId;
  if (cmd.frameSelector) opts.frameSelector = cmd.frameSelector;
  if (cmd.frameIndex !== undefined && cmd.frameIndex !== null) opts.frameIndex = cmd.frameIndex;
  if (cmd.allFrames) opts.allFrames = true;
  return opts;
}

async function buildInjectionTarget(tabId, opts = {}) {
  if (opts.frameSelector && opts.frameId === undefined) {
    const frame = await resolveFrameId(tabId, opts.frameSelector, opts.frameIndex || 0);
    return { tabId, frameIds: [frame.frameId] };
  }
  if (opts.frameId !== undefined && opts.frameId !== null) {
    const frameId = Number(opts.frameId);
    if (!Number.isInteger(frameId) || frameId < 0) throw new Error("frameId must be a non-negative integer");
    return { tabId, frameIds: [frameId] };
  }
  if (opts.allFrames) return { tabId, allFrames: true };
  return { tabId };
}

function unwrapInjectionResults(results, preferSuccess = () => false) {
  if (!Array.isArray(results) || results.length === 0) return undefined;
  if (results.length === 1) return results[0]?.result;

  const mapped = results.map((entry) => ({
    frameId: entry.frameId,
    documentId: entry.documentId,
    result: entry.result,
  }));
  const success = mapped.find((entry) => preferSuccess(entry.result));
  return success?.result || mapped.find((entry) => !entry.result?.error)?.result || mapped[0]?.result;
}

async function resolveFrameId(tabId, iframeSelector, index = 0) {
  if (!iframeSelector) throw new Error("resolveFrame requires frameSelector");
  const frameIndex = Number(index) || 0;
  const [iframeResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector, idx) => {
      const iframe = Array.from(document.querySelectorAll(selector))[idx];
      if (!iframe) return { found: false };
      const attrSrc = iframe.getAttribute("src") || "";
      return {
        found: true,
        selector,
        index: idx,
        src: iframe.src || attrSrc,
        attrSrc,
        id: iframe.id || "",
        name: iframe.name || iframe.getAttribute("name") || "",
      };
    },
    args: [iframeSelector, frameIndex],
  });
  const iframe = iframeResult?.result;
  if (!iframe?.found) throw new Error(`iframe not found: ${iframeSelector}`);

  try {
    const frameElementMatches = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (selector, expected) => {
        if (window.top === window) return { matches: false };
        try {
          const el = window.frameElement;
          if (!el?.matches?.(selector)) return { matches: false };
          const attrSrc = el.getAttribute?.("src") || "";
          const src = el.src || attrSrc || "";
          const id = el.id || "";
          const name = el.name || el.getAttribute?.("name") || "";
          // Index must be computed against the top document — the same root
          // resolveFrameId used for querySelectorAll. Nested frames are absent
          // from that list (indexAmong stays -1) and must not win on local index.
          let indexAmong = -1;
          try {
            indexAmong = Array.from(window.top.document.querySelectorAll(selector)).indexOf(el);
          } catch {}
          const isBlankish = (value) => {
            const v = String(value || "").trim();
            return !v || v === "about:blank" || v === "about:srcdoc";
          };
          const idMatch = !!(expected.id && id === expected.id);
          const nameMatch = !!(expected.name && name === expected.name);
          // Empty/about:blank src values are not discriminating — ignore them.
          const srcMatch = !isBlankish(expected.src) && (src === expected.src || (!isBlankish(expected.attrSrc) && attrSrc === expected.attrSrc));
          const attrMatch = !isBlankish(expected.attrSrc) && attrSrc === expected.attrSrc;
          return {
            matches: true,
            indexMatch: indexAmong >= 0 && indexAmong === expected.index,
            strongIdentity: idMatch || nameMatch,
            srcIdentity: srcMatch || attrMatch,
            indexAmong,
            src,
            attrSrc,
          };
        } catch (e) {
          return { matches: false, error: e.message };
        }
      },
      args: [iframeSelector, {
        index: frameIndex,
        src: iframe.src,
        attrSrc: iframe.attrSrc,
        id: iframe.id,
        name: iframe.name,
      }],
    });
    const matchedFrames = frameElementMatches
      .filter((entry) => entry.frameId !== 0 && entry.result?.matches);

    // DOM index is authoritative for same-origin frames.
    const byIndex = matchedFrames.find((entry) => entry.result?.indexMatch);
    if (byIndex) {
      return {
        ...iframe,
        frameId: byIndex.frameId,
        frameUrl: byIndex.result?.src || "",
        matchedBy: "frameElement-index",
      };
    }

    const byStrong = matchedFrames.filter((entry) => entry.result?.strongIdentity);
    if (byStrong.length === 1) {
      return {
        ...iframe,
        frameId: byStrong[0].frameId,
        frameUrl: byStrong[0].result?.src || "",
        matchedBy: "frameElement",
      };
    }

    const bySrc = matchedFrames.filter((entry) => entry.result?.srcIdentity);
    if (bySrc.length === 1) {
      return {
        ...iframe,
        frameId: bySrc[0].frameId,
        frameUrl: bySrc[0].result?.src || "",
        matchedBy: "frameElement-src",
      };
    }
  } catch {}

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  if (!frames?.length) throw new Error("No frames found for tab");
  const candidates = frames.filter((frame) => frame.frameId !== 0);
  const normalizedSrc = normalizeUrlForFrameMatch(iframe.src || iframe.attrSrc);
  const normalizedAttrSrc = normalizeUrlForFrameMatch(iframe.attrSrc);
  const isBlankishUrl = (value) => {
    const v = String(value || "").trim();
    return !v || v === "about:blank" || v === "about:srcdoc";
  };

  // Unique URL match only. webNavigation order is not DOM order, so never
  // disambiguate same-URL frames with frameIndex here.
  const pickUniqueUrlMatch = (matches, matchedBy) => {
    if (matches.length !== 1) return null;
    return { ...iframe, frameId: matches[0].frameId, frameUrl: matches[0].url, matchedBy };
  };

  if (!isBlankishUrl(normalizedSrc) || !isBlankishUrl(normalizedAttrSrc)) {
    const exactMatches = candidates.filter((frame) => {
      const frameUrl = normalizeUrlForFrameMatch(frame.url);
      return frameUrl && (frameUrl === normalizedSrc || frameUrl === normalizedAttrSrc);
    });
    const exact = pickUniqueUrlMatch(exactMatches, "url");
    if (exact) return exact;

    const looseMatches = candidates.filter((frame) => {
      const frameUrl = normalizeUrlForFrameMatch(frame.url);
      return normalizedSrc && frameUrl && (frameUrl.startsWith(normalizedSrc) || normalizedSrc.startsWith(frameUrl));
    });
    const loose = pickUniqueUrlMatch(looseMatches, "url-prefix");
    if (loose) return loose;
  }

  // Only safe when the caller asked for the first match and there is exactly
  // one child frame in the tab — otherwise this can bind an unrelated frame.
  if (frameIndex === 0 && candidates.length === 1) {
    const only = candidates[0];
    return { ...iframe, frameId: only.frameId, frameUrl: only.url, matchedBy: "single-child-frame" };
  }

  throw new Error(`Unable to match iframe selector to a frameId: ${iframeSelector}`);
}

function normalizeUrlForFrameMatch(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return String(url).split("#")[0];
  }
}

// =============================================================================
// Injection helpers — all use serialized functions (no eval, Trusted Types safe)
// =============================================================================

async function injectReadPage(tabId, selector, maxElements) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, max) => {
      window.__carrotRefs = {};
      window.__carrotRefCounter = 0;
      let refCounter = 0;
      const refs = window.__carrotRefs;
      const results = [];

      const INTERACTIVE = new Set([
        "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "DETAILS", "SUMMARY",
        "LABEL", "OPTION", "DIALOG",
      ]);
      const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "META", "LINK", "BR", "HR"]);

      function isVisible(el) {
        if (!el.offsetParent && el.tagName !== "BODY" && el.tagName !== "HTML" &&
            getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "sticky") return false;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        return true;
      }

      function getRole(el) {
        if (el.getAttribute("role")) return el.getAttribute("role");
        const tag = el.tagName;
        if (tag === "A" && el.href) return "link";
        if (tag === "BUTTON" || el.type === "button" || el.type === "submit") return "button";
        if (tag === "INPUT") return el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : "textbox";
        if (tag === "TEXTAREA") return "textbox";
        if (tag === "SELECT") return "combobox";
        if (tag === "IMG") return "img";
        if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") return "heading";
        if (tag === "NAV") return "navigation";
        if (tag === "MAIN") return "main";
        if (tag === "ASIDE") return "complementary";
        if (tag === "FOOTER") return "contentinfo";
        if (tag === "HEADER") return "banner";
        if (el.getAttribute("contenteditable") === "true") return "textbox";
        return null;
      }

      function walk(root) {
        if (results.length >= max) return;
        const children = root.children;
        for (let i = 0; i < children.length; i++) {
          if (results.length >= max) return;
          const el = children[i];
          if (SKIP.has(el.tagName)) continue;
          if (!isVisible(el)) continue;

          const role = getRole(el);
          const isInteractive = INTERACTIVE.has(el.tagName) || el.getAttribute("contenteditable") === "true"
            || el.getAttribute("role") === "button" || el.getAttribute("role") === "link"
            || el.getAttribute("tabindex") !== null || el.onclick;
          const text = el.innerText?.slice(0, 200)?.trim() || "";
          const hasText = text.length > 0;

          if (role || isInteractive || (hasText && el.children.length === 0)) {
            refCounter++;
            const refId = "ref_" + refCounter;
            refs[refId] = el;
            el.dataset.carrotRef = refId;

            const entry = { ref: refId, tag: el.tagName.toLowerCase() };
            if (role) entry.role = role;
            if (text) entry.text = text.slice(0, 120);
            if (el.getAttribute("aria-label")) entry.ariaLabel = el.getAttribute("aria-label");
            if (el.getAttribute("placeholder")) entry.placeholder = el.getAttribute("placeholder");
            if (el.href) entry.href = el.href;
            if (el.value !== undefined && el.value !== "") entry.value = String(el.value).slice(0, 200);
            if (el.type) entry.type = el.type;
            if (el.checked !== undefined) entry.checked = el.checked;
            if (el.disabled) entry.disabled = true;
            if (el.getAttribute("contenteditable") === "true") entry.contenteditable = true;
            if (el.name) entry.name = el.name;
            results.push(entry);
          }
          walk(el);
        }
      }

      const root = document.querySelector(sel) || document.body;
      walk(root);
      window.__carrotRefCounter = refCounter;
      return { elements: results, count: results.length, url: location.href, title: document.title };
    },
    args: [selector, maxElements],
  });
  return r?.result;
}

async function injectFind(tabId, query, role, limit) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (q, roleFilter, lim) => {
      window.__carrotRefs = {};
      window.__carrotRefCounter = 0;
      let refCounter = 0;
      const refs = window.__carrotRefs;
      const results = [];
      const qLower = q.toLowerCase();

      const all = document.querySelectorAll("*");
      for (let i = 0; i < all.length && results.length < lim; i++) {
        const el = all[i];
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;

        const text = (el.innerText || "").slice(0, 300).trim();
        const aria = el.getAttribute("aria-label") || "";
        const placeholder = el.getAttribute("placeholder") || "";
        const elRole = el.getAttribute("role") || "";
        const title = el.getAttribute("title") || "";

        const haystack = (text + " " + aria + " " + placeholder + " " + title).toLowerCase();
        if (qLower && !haystack.includes(qLower)) continue;
        if (roleFilter && elRole !== roleFilter && tag.toLowerCase() !== roleFilter) continue;

        if (!el.offsetParent && tag !== "BODY" && tag !== "HTML" &&
            getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "sticky") continue;
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") continue;

        refCounter++;
        const refId = "ref_" + refCounter;
        refs[refId] = el;
        el.dataset.carrotRef = refId;

        const entry = { ref: refId, tag: tag.toLowerCase() };
        if (text) entry.text = text.slice(0, 120);
        if (aria) entry.ariaLabel = aria;
        if (placeholder) entry.placeholder = placeholder;
        if (elRole) entry.role = elRole;
        if (el.href) entry.href = el.href;
        if (el.type) entry.type = el.type;
        if (el.name) entry.name = el.name;
        results.push(entry);
      }
      window.__carrotRefCounter = refCounter;
      return { matches: results, count: results.length };
    },
    args: [query, role || "", limit],
  });
  return r?.result;
}

async function injectGetPageText(tabId, selector, maxLength) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, maxLen) => {
      const el = document.querySelector(sel);
      if (!el) return { text: "", url: location.href, title: document.title };
      return {
        text: el.innerText.slice(0, maxLen),
        url: location.href,
        title: document.title,
      };
    },
    args: [selector, maxLength],
  });
  return r?.result;
}

async function injectAction(tabId, action, opts) {
  const target = await buildInjectionTarget(tabId, opts);
  const results = await chrome.scripting.executeScript({
    target,
    func: (act, ref, selector, index, text, value, maxScrolls) => {
      function resolveEl(r, sel, idx) {
        if (r && window.__carrotRefs && window.__carrotRefs[r]) return window.__carrotRefs[r];
        if (r) { const d = document.querySelector('[data-carrot-ref="' + r + '"]'); if (d) return d; }
        if (sel) { const els = document.querySelectorAll(sel); return els[idx || 0] || null; }
        return null;
      }

      if (act === "click") {
        const el = resolveEl(ref, selector, index);
        if (!el) return { clicked: false, error: "element not found" };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        return { clicked: true, tag: el.tagName, ref: el.dataset?.carrotRef || null };
      }

      if (act === "hover") {
        const el = resolveEl(ref, selector, index);
        if (!el) return { hovered: false, error: "element not found" };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        return { hovered: true, tag: el.tagName, ref: el.dataset?.carrotRef || null };
      }

      if (act === "type") {
        const el = resolveEl(ref, selector, index);
        if (!el) return { typed: false, error: "element not found" };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        if (el.getAttribute("contenteditable") === "true") {
          el.textContent = "";
          el.appendChild(document.createTextNode(text));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        } else {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { typed: true, tag: el.tagName, ref: el.dataset?.carrotRef || null };
      }

      if (act === "formInput") {
        const el = resolveEl(ref, selector, index);
        if (!el) return { set: false, error: "element not found" };
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const tag = el.tagName;
        if (tag === "SELECT") {
          el.value = value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { set: true, type: "select", value: el.value };
        }
        if (el.type === "checkbox" || el.type === "radio") {
          el.checked = !!value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("click", { bubbles: true }));
          return { set: true, type: el.type, checked: el.checked };
        }
        el.focus();
        if (el.getAttribute("contenteditable") === "true") {
          el.textContent = String(value);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
        } else {
          el.value = String(value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { set: true, type: el.type || tag.toLowerCase(), value: el.value ?? el.textContent };
      }

      if (act === "fillContentEditable") {
        const comments = document.querySelector("#comments, ytd-comments");
        if (comments) comments.scrollIntoView({ block: "start", behavior: "instant" });
        const clickPh = () => { const ph = document.querySelector("#placeholder-area"); if (ph) ph.click(); };
        for (let i = 0; i < (maxScrolls || 24); i++) {
          if (i === 2 || i === 7) clickPh();
          const root = resolveEl(ref, selector, 0);
          if (root && root.getAttribute("contenteditable") === "true") {
            root.focus();
            root.textContent = "";
            root.appendChild(document.createTextNode(text));
            root.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
            return { ok: true, scrolls: i };
          }
          window.scrollBy(0, 380);
        }
        return { ok: false, message: "contenteditable not found" };
      }

      return { error: "unknown action: " + act };
    },
    args: [action, opts.ref ?? "", opts.selector ?? "", opts.index || 0, opts.text || "", opts.value ?? "", opts.maxScrolls || 24],
  });
  return unwrapInjectionResults(results, (result) =>
    !!(result?.clicked || result?.hovered || result?.typed || result?.set || result?.ok)
  );
}

async function injectScroll(tabId, ref, selector, direction, amount) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (rf, sel, dir, amt) => {
      let el = null;
      if (rf && window.__carrotRefs && window.__carrotRefs[rf]) el = window.__carrotRefs[rf];
      else if (sel && sel !== "window") el = document.querySelector(sel);

      const px = amt || (dir === "up" ? -800 : dir === "left" ? -400 : dir === "right" ? 400 : 800);
      const horiz = (dir === "left" || dir === "right");

      if (!el || sel === "window") {
        if (horiz) window.scrollBy(px, 0); else window.scrollBy(0, px);
      } else {
        if (horiz) el.scrollBy(px, 0); else el.scrollBy(0, px);
      }
      return { scrolled: true, direction: dir, amount: px };
    },
    args: [ref ?? null, selector || "window", direction, amount || 0],
  });
  return r?.result;
}

async function injectPress(tabId, key, ref, selector) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k, rf, sel) => {
      let target = document.activeElement || document;
      if (rf && window.__carrotRefs && window.__carrotRefs[rf]) target = window.__carrotRefs[rf];
      else if (sel) target = document.querySelector(sel) || document;

      const opts = { key: k, bubbles: true, cancelable: true };
      if (k === "Enter") opts.keyCode = 13;
      if (k === "Escape") opts.keyCode = 27;
      if (k === "Tab") opts.keyCode = 9;

      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
      return { pressed: k };
    },
    args: [key ?? "", ref ?? "", selector ?? ""],
  });
  return r?.result;
}

async function injectQuery(tabId, selector, limit) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, lim) => {
      window.__carrotRefs = {};
      window.__carrotRefCounter = 0;
      let refCounter = 0;
      const els = Array.from(document.querySelectorAll(sel)).slice(0, lim);
      const results = els.map((el, i) => {
        refCounter++;
        const refId = "ref_" + refCounter;
        window.__carrotRefs[refId] = el;
        el.dataset.carrotRef = refId;
        return {
          ref: refId, index: i,
          text: (el.innerText || "").slice(0, 2000),
          tag: el.tagName,
          href: el.getAttribute("href") || "",
        };
      });
      window.__carrotRefCounter = refCounter;
      return results;
    },
    args: [selector, limit],
  });
  return r?.result;
}

async function injectReadConsole(tabId, install) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (doInstall) => {
      if (!window.__carrotConsoleOrig) {
        window.__carrotConsoleOrig = {};
        for (const level of ["log", "warn", "error", "info", "debug"]) {
          window.__carrotConsoleOrig[level] = console[level].bind(console);
        }
      }
      if (!window.__carrotConsole || doInstall) {
        window.__carrotConsole = [];
        const MAX = 200;
        for (const level of ["log", "warn", "error", "info", "debug"]) {
          const orig = window.__carrotConsoleOrig[level];
          console[level] = function (...args) {
            if (window.__carrotConsole.length < MAX) {
              window.__carrotConsole.push({
                level,
                message: args.map(a => { try { return typeof a === "object" ? JSON.stringify(a).slice(0, 500) : String(a); } catch { return String(a); } }).join(" "),
                ts: Date.now(),
              });
            }
            orig(...args);
          };
        }
        if (!window.__carrotConsoleErrorHandler) {
          window.__carrotConsoleErrorHandler = true;
          window.addEventListener("error", (e) => {
            if (window.__carrotConsole && window.__carrotConsole.length < MAX)
              window.__carrotConsole.push({ level: "exception", message: e.message + " at " + e.filename + ":" + e.lineno, ts: Date.now() });
          });
        }
      }
      const msgs = window.__carrotConsole.splice(0);
      return { messages: msgs, count: msgs.length };
    },
    args: [install],
  });
  return r?.result;
}

async function injectReadNetwork(tabId, install) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (doInstall) => {
      if (!window.__carrotNetworkOrig) {
        window.__carrotNetworkOrig = {
          fetch: window.fetch.bind(window),
          xhrOpen: XMLHttpRequest.prototype.open,
          xhrSend: XMLHttpRequest.prototype.send,
        };
      }
      if (!window.__carrotNetwork || doInstall) {
        window.__carrotNetwork = [];
        const MAX = 200;
        const origFetch = window.__carrotNetworkOrig.fetch;

        window.fetch = async function (input, init) {
          const url = typeof input === "string" ? input : input?.url || String(input);
          const method = init?.method || "GET";
          const entry = { type: "fetch", method, url: url.slice(0, 500), ts: Date.now() };
          try {
            const resp = await origFetch(input, init);
            entry.status = resp.status;
            if (window.__carrotNetwork.length < MAX) window.__carrotNetwork.push(entry);
            return resp;
          } catch (e) {
            entry.error = e.message;
            if (window.__carrotNetwork.length < MAX) window.__carrotNetwork.push(entry);
            throw e;
          }
        };

        const origOpen = window.__carrotNetworkOrig.xhrOpen;
        const origSend = window.__carrotNetworkOrig.xhrSend;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__carrot = { type: "xhr", method, url: String(url).slice(0, 500), ts: Date.now() };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          this.addEventListener("loadend", () => {
            if (this.__carrot) {
              this.__carrot.status = this.status;
              if (window.__carrotNetwork.length < MAX) window.__carrotNetwork.push(this.__carrot);
            }
          });
          return origSend.apply(this, arguments);
        };
      }
      const reqs = window.__carrotNetwork.splice(0);
      return { requests: reqs, count: reqs.length };
    },
    args: [install],
  });
  return r?.result;
}

async function injectEval(tabId, code, world = "MAIN", opts = {}) {
  const target = await buildInjectionTarget(tabId, opts);
  const results = await chrome.scripting.executeScript({
    target,
    func: (c) => {
      try {
        return { ok: true, value: eval(c) };
      } catch (e) {
        return { ok: false, error: e.message, stack: e.stack };
      }
    },
    args: [code],
    world,
  });
  const res = unwrapInjectionResults(results, (result) => result?.ok);
  if (res && !res.ok) throw new Error(res.error);
  return res?.value;
}

// Keep-alive + toolbar badge. Gold when an agent is actively using the
// browser, subtle dot when merely connected, empty when offline.
chrome.runtime.onConnect.addListener(() => {});
setInterval(() => {
  const controlled = controlledTabs.size > 0;
  if (controlled) {
    chrome.action.setBadgeText({ text: String(controlledTabs.size) });
    chrome.action.setBadgeBackgroundColor({ color: "#facd2a" });
    chrome.action.setBadgeTextColor?.({ color: "#0a0a0a" });
  } else if (connected) {
    chrome.action.setBadgeText({ text: "●" });
    chrome.action.setBadgeBackgroundColor({ color: "#0a0a0a" });
    chrome.action.setBadgeTextColor?.({ color: "#facd2a" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}, 2000);
