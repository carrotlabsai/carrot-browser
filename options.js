const STORAGE_KEY_SERVER = "carrot_server_url";
const STORAGE_KEY_BROWSER_ID = "carrot_browser_id";
const STORAGE_KEY_BROWSER_TOKEN = "carrot_browser_token";
const STORAGE_KEY_USE_WS = "carrot_use_ws";
const DEFAULT_SERVER = "https://browser.carrotlabs.ai";

const serverUrlInput = document.getElementById("serverUrl");
const statusMsg = document.getElementById("statusMsg");
const browserIdEl = document.getElementById("browserId");
const connModeEl = document.getElementById("connMode");
const useWsCheckbox = document.getElementById("useWs");

function showStatus(text, ok) {
  statusMsg.textContent = text;
  statusMsg.className = "status-msg " + (ok ? "ok" : "err");
}

async function load() {
  const data = await chrome.storage.local.get([
    STORAGE_KEY_SERVER, STORAGE_KEY_BROWSER_ID, STORAGE_KEY_USE_WS,
  ]);
  serverUrlInput.value = data[STORAGE_KEY_SERVER] || DEFAULT_SERVER;
  browserIdEl.textContent = data[STORAGE_KEY_BROWSER_ID] || "(not yet generated)";
  useWsCheckbox.checked = data[STORAGE_KEY_USE_WS] !== false;
  connModeEl.textContent = useWsCheckbox.checked ? "WebSocket" : "HTTP Polling";
}

document.getElementById("save").addEventListener("click", async () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, "");
  if (!url) {
    showStatus("URL cannot be empty", false);
    return;
  }
  await chrome.storage.local.set({
    [STORAGE_KEY_SERVER]: url,
    [STORAGE_KEY_USE_WS]: useWsCheckbox.checked,
  });
  connModeEl.textContent = useWsCheckbox.checked ? "WebSocket" : "HTTP Polling";
  showStatus("Saved. Extension will reconnect.", true);
});

document.getElementById("test").addEventListener("click", async () => {
  const url = serverUrlInput.value.trim().replace(/\/+$/, "");
  if (!url) {
    showStatus("Enter a URL first", false);
    return;
  }
  showStatus("Testing...", true);
  try {
    const resp = await fetch(`${url}/status`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    if (data.connected !== undefined) {
      const browsers = data.browsers_online ?? data.browsers?.length ?? 0;
      showStatus(
        `Connected. Auth: ${data.auth_required ? "required" : "off"}. ` +
        `${browsers} browser(s) online.`,
        true,
      );
    } else {
      showStatus("Server responded but format unexpected", false);
    }
  } catch (e) {
    showStatus(`Failed: ${e.message || "could not reach server"}`, false);
  }
});

document.getElementById("resetId").addEventListener("click", async () => {
  if (!confirm("Reset browser identity? All active agent sessions will be invalidated.")) return;
  const browserId = crypto.randomUUID();
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const browserToken = btoa(String.fromCharCode(...tokenBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await chrome.storage.local.set({
    [STORAGE_KEY_BROWSER_ID]: browserId,
    [STORAGE_KEY_BROWSER_TOKEN]: browserToken,
  });
  browserIdEl.textContent = browserId;
  chrome.runtime.sendMessage({ type: "reconnect" });
  showStatus("Identity reset. Extension reconnecting.", true);
});

useWsCheckbox.addEventListener("change", () => {
  connModeEl.textContent = useWsCheckbox.checked ? "WebSocket" : "HTTP Polling";
});

load();
