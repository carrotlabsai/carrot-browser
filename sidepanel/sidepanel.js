// ---------------------------------------------------------------------------
// Carrot — Side Panel controller
// Live activity feed, session status, pairing, settings access.
// Talks to the background service worker via chrome.runtime messaging.
// ---------------------------------------------------------------------------

const DEFAULT_SERVER = "https://browser.carrotlabs.ai";
const SKILL_URL = "https://github.com/carrotlabsai/carrot-browser/blob/main/SKILL.md";
const MAX_ACTIVITY = 120;

// --- Elements ----------------------------------------------------------------
const shell = document.querySelector(".sp-shell");

// Header
const statusIndicator = document.getElementById("statusIndicator");
const statusDot = statusIndicator.querySelector(".cl-dot");
const openSettingsBtn = document.getElementById("openSettings");

// Pairing
const scopeSelect = document.getElementById("scopeSelect");
const scopeIcon = document.getElementById("scopeIcon");
const generateBtn = document.getElementById("generateCode");
const codeDisplay = document.getElementById("codeDisplay");
const pairingCodeEl = document.getElementById("pairingCode");
const codeHintEl = document.getElementById("codeHint");
const copyCodeBtn = document.getElementById("copyCode");
const copyRawCodeBtn = document.getElementById("copyRawCode");
const agentStack = document.getElementById("agentStack");

// Activity feed + sessions
const activityList = document.getElementById("activityList");
const clearActivityBtn = document.getElementById("clearActivity");
const sessionsList = document.getElementById("sessionsList");

// --- State -------------------------------------------------------------------
let activity = [];
let sessions = [];
let connected = false;
let codeHideTimer = null;

// ---------------------------------------------------------------------------
// Scope selector options (current tab / window / browser)
// ---------------------------------------------------------------------------

async function loadScopeOptions() {
  try {
    const tab = await getCurrentPanelTab();
    if (!tab) return;
    updateScopeOptionsForTab(tab);
  } catch {}
}

function updateScopeOptionsForTab(tab) {
  const previousValue = scopeSelect.value;
  const previousKind = scopeKind(previousValue);
  const hadDynamicScope = Array.from(scopeSelect.options).some((o) => scopeKind(o.value) !== "static");

  removeDynamicScopeOptions();

  const tabOpt = document.createElement("option");
  tabOpt.value = `tab:${tab.id}`;
  tabOpt.textContent = `This tab · ${truncate(tab.title || "", 30)}`;
  scopeSelect.insertBefore(tabOpt, scopeSelect.firstChild);

  const winOpt = document.createElement("option");
  winOpt.value = `window:${tab.windowId}`;
  winOpt.textContent = "This window · active window";
  scopeSelect.insertBefore(winOpt, scopeSelect.children[1]);

  if (previousKind === "static" && hadDynamicScope) {
    scopeSelect.value = previousValue;
  } else if (previousKind === "window") {
    scopeSelect.value = winOpt.value;
  } else {
    scopeSelect.value = tabOpt.value;
  }
  updateScopeIcon();
}

async function getCurrentPanelTab() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (currentWindow?.id != null) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindow.id });
      if (tab) return tab;
    }
  } catch {}

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function removeDynamicScopeOptions() {
  for (const option of Array.from(scopeSelect.options)) {
    if (scopeKind(option.value) !== "static") option.remove();
  }
}

function scopeKind(value) {
  if (value.startsWith("tab:")) return "tab";
  if (value.startsWith("window:")) return "window";
  return "static";
}

function updateScopeIcon() {
  const value = scopeSelect.value;
  scopeIcon.replaceChildren(getScopeIcon(value));
}

function getScopeIcon(value) {
  if (value.startsWith("tab:")) return iconTabScope();
  if (value.startsWith("window:")) return iconWindowScope();
  return iconBrowserScope();
}

// ---------------------------------------------------------------------------
// Connection status — single dot in the header tells you everything
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: "get_status" });
    if (!status) return;
    connected = !!status.connected;
    if (connected) {
      statusDot.classList.add("on");
      const tip = sessions.length > 0 ? "Agent active" : "Connected";
      statusIndicator.title = tip;
    } else {
      statusDot.classList.remove("on");
      statusIndicator.title = "Offline — start the bridge server";
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function renderSessions() {
  sessionsList.innerHTML = "";
  const active = sessions.length > 0;
  shell.classList.toggle("is-active", active);
  agentStack.hidden = !active;

  if (!active) return;

  // Session rows (so multiple agents can be revoked individually)
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "sp-session";
    const info = document.createElement("div");
    info.className = "sp-session-info";
    const name = document.createElement("div");
    name.className = "sp-session-name";
    name.textContent = s.agent_name || "Agent";
    const meta = document.createElement("div");
    meta.className = "sp-session-meta";
    const since = new Date(s.created * 1000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    meta.textContent = `${s.scope} · since ${since}`;
    info.append(name, meta);

    const revoke = document.createElement("button");
    revoke.className = "cl-btn cl-btn-danger";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "revoke_session",
        session_id: s.session_id,
      });
    });
    row.append(info, revoke);
    sessionsList.appendChild(row);
  }
}

function refreshSessions() {
  chrome.runtime.sendMessage({ type: "list_sessions" });
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

const ACTION_ICONS = {
  click: iconMouse,
  hover: iconMouse,
  type: iconKeyboard,
  formInput: iconKeyboard,
  press: iconKeyboard,
  navigate: iconArrow,
  goBack: iconArrow,
  goForward: iconArrow,
  reloadTab: iconRefresh,
  readPage: iconEye,
  find: iconSearch,
  query: iconSearch,
  getPageText: iconEye,
  dom: iconEye,
  screenshot: iconCamera,
  scroll: iconScroll,
  createTab: iconPlus,
  closeTab: iconX,
  duplicateTab: iconPlus,
  execute: iconCode,
  default: iconSpark,
};

function getIcon(type) {
  const factory = ACTION_ICONS[type] || ACTION_ICONS.default;
  return factory();
}

function pushActivity(entry) {
  activity.unshift(entry);
  if (activity.length > MAX_ACTIVITY) activity.pop();
  renderActivity(true);
}

function renderActivity(justAdded = false) {
  if (!activity.length) {
    activityList.innerHTML = "";
    return;
  }
  const existingCount = activityList.querySelectorAll(".sp-activity-row").length;
  if (!justAdded || existingCount === 0) {
    activityList.innerHTML = "";
    for (const entry of activity) activityList.appendChild(buildRow(entry));
    return;
  }
  const row = buildRow(activity[0], true);
  activityList.prepend(row);
  const rows = activityList.querySelectorAll(".sp-activity-row");
  if (rows.length > MAX_ACTIVITY) rows[rows.length - 1].remove();
}

function buildRow(entry, isNew = false) {
  const row = document.createElement("div");
  row.className = "sp-activity-row" + (isNew ? " is-new" : "");

  const icon = document.createElement("div");
  icon.className = "sp-activity-icon" + (entry.error ? " is-error" : "");
  icon.appendChild(getIcon(entry.type));

  const body = document.createElement("div");
  body.className = "sp-activity-body";

  const header = document.createElement("div");
  header.className = "sp-activity-action";
  const action = document.createElement("span");
  action.textContent = humanize(entry.type);
  const time = document.createElement("span");
  time.className = "sp-activity-time";
  time.textContent = formatTime(entry.ts);
  header.append(action);
  if (entry.agentName) {
    const agent = document.createElement("span");
    agent.className = "sp-activity-agent";
    agent.textContent = entry.agentName;
    header.append(agent);
  }
  header.append(time);

  const detail = document.createElement("div");
  detail.className = "sp-activity-detail";
  detail.textContent = entry.detail || "";

  body.append(header, detail);
  row.append(icon, body);
  return row;
}

function clearActivity() {
  activity = [];
  renderActivity();
}

clearActivityBtn.addEventListener("click", clearActivity);

// ---------------------------------------------------------------------------
// Pairing flow
// ---------------------------------------------------------------------------

generateBtn.addEventListener("click", () => {
  const scope = scopeSelect.value;
  chrome.runtime.sendMessage({ type: "create_pairing", scope });
  resetPairingCode();
  generateBtn.disabled = true;
  const label = generateBtn.querySelector("span");
  if (label) label.textContent = "Requesting…";
  setTimeout(() => {
    generateBtn.disabled = false;
    if (label) label.textContent = "Pair an Agent";
  }, 3000);
});

scopeSelect.addEventListener("change", updateScopeIcon);

copyCodeBtn.addEventListener("click", async () => {
  const code = getCurrentPairingCode();
  if (!code) return;

  await navigator.clipboard.writeText(buildAgentPrompt(code));
  flashButtonLabel(copyCodeBtn, "Copied");
});

copyRawCodeBtn.addEventListener("click", async () => {
  const code = getCurrentPairingCode();
  if (!code) return;

  await navigator.clipboard.writeText(code);
  copyRawCodeBtn.classList.add("is-copied");
  setTimeout(() => copyRawCodeBtn.classList.remove("is-copied"), 900);
});

openSettingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Message listener — server events + background broadcasts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  switch (msg.action || msg.type) {
    case "pairing_code":
      pairingCodeEl.textContent = msg.code;
      codeHintEl.innerHTML = `Give this code to the agent · expires in <span id="codeExpiry">${Math.round((msg.expires_in || 300) / 60)}</span> min`;
      codeDisplay.hidden = false;
      codeDisplay.classList.remove("is-claimed");
      copyCodeBtn.hidden = false;
      generateBtn.disabled = false;
      {
        const label = generateBtn.querySelector("span");
        if (label) label.textContent = "Pair an Agent";
      }
      break;
    case "sessions_list":
      sessions = msg.sessions || [];
      renderSessions();
      break;
    case "session_claimed":
      showClaimedCode(msg.agent_name || "Agent");
      refreshSessions();
      break;
    case "session_revoked":
      refreshSessions();
      break;
    case "carrot_activity":
      pushActivity(msg.entry);
      break;
    case "carrot_activity_clear":
      clearActivity();
      break;
    case "scope_tab_changed":
      if (msg.tab) updateScopeOptionsForTab(msg.tab);
      break;
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

refreshStatus();
loadScopeOptions();
refreshSessions();
setInterval(refreshStatus, 2500);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function getCurrentPairingCode() {
  const code = pairingCodeEl.textContent?.trim();
  if (!code || code === "—" || code === "Claimed") return null;
  return code;
}

function buildAgentPrompt(code) {
  return `connect to my browser using the skill at ${SKILL_URL} or MCP if installed. Code: ${code}.`;
}

function flashButtonLabel(button, label) {
  const prev = button.textContent;
  button.textContent = label;
  setTimeout(() => (button.textContent = prev), 1400);
}

function resetPairingCode() {
  if (codeHideTimer) {
    clearTimeout(codeHideTimer);
    codeHideTimer = null;
  }
  codeDisplay.hidden = true;
  codeDisplay.classList.remove("is-claimed");
  codeHintEl.innerHTML = 'Give this code to the agent · expires in <span id="codeExpiry">5</span> min';
  copyCodeBtn.hidden = false;
}

function showClaimedCode(agentName) {
  if (codeHideTimer) clearTimeout(codeHideTimer);
  pairingCodeEl.textContent = "Claimed";
  codeHintEl.textContent = `${agentName} connected`;
  codeDisplay.hidden = false;
  codeDisplay.classList.add("is-claimed");
  copyCodeBtn.hidden = true;
  codeHideTimer = setTimeout(() => {
    codeDisplay.hidden = true;
    codeDisplay.classList.remove("is-claimed");
    copyCodeBtn.hidden = false;
    codeHideTimer = null;
  }, 1200);
}

function humanize(type) {
  const map = {
    click: "Click",
    hover: "Hover",
    type: "Type",
    formInput: "Form input",
    press: "Key press",
    navigate: "Navigate",
    goBack: "Back",
    goForward: "Forward",
    reloadTab: "Reload",
    readPage: "Read page",
    find: "Find element",
    query: "Query DOM",
    getPageText: "Read text",
    dom: "Read DOM",
    screenshot: "Screenshot",
    scroll: "Scroll",
    createTab: "New tab",
    closeTab: "Close tab",
    duplicateTab: "Duplicate tab",
    execute: "Execute script",
    readConsole: "Read console",
    readNetwork: "Read network",
    focused: "Get focused tab",
    tabs: "List tabs",
  };
  return map[type] || type;
}

function formatTime(ts) {
  const delta = Date.now() - ts;
  if (delta < 1500) return "now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

setInterval(() => {
  const times = activityList.querySelectorAll(".sp-activity-time");
  activity.slice(0, times.length).forEach((entry, i) => {
    times[i].textContent = formatTime(entry.ts);
  });
}, 5000);

// ---------------------------------------------------------------------------
// SVG icon helpers (inline, no external dependencies)
// ---------------------------------------------------------------------------

function svg(path, viewBox = "0 0 24 24") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("width", "12");
  el.setAttribute("height", "12");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.innerHTML = path;
  return el;
}

function iconMouse() {
  return svg(
    '<path d="M12 2 l0 10"/><circle cx="12" cy="12" r="3"/><path d="M7 22l5-7 5 7"/>',
  );
}
function iconKeyboard() {
  return svg(
    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h12"/>',
  );
}
function iconArrow() {
  return svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>');
}
function iconRefresh() {
  return svg(
    '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>',
  );
}
function iconEye() {
  return svg(
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  );
}
function iconSearch() {
  return svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>');
}
function iconCamera() {
  return svg(
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  );
}
function iconScroll() {
  return svg(
    '<path d="M12 5v14"/><path d="M6 11l6 6 6-6"/><path d="M6 13l6-6 6 6"/>',
  );
}
function iconPlus() {
  return svg('<path d="M12 5v14M5 12h14"/>');
}
function iconX() {
  return svg('<path d="M18 6L6 18M6 6l12 12"/>');
}
function iconCode() {
  return svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
}
function iconTabScope() {
  return svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>');
}
function iconWindowScope() {
  return svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M8 5v4"/>');
}
function iconBrowserScope() {
  return svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/>');
}
function iconSpark() {
  return svg(
    '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  );
}
