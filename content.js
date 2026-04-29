// ---------------------------------------------------------------------------
// Carrot — Content script
// 1. Keeps the background service worker alive via a long-lived port.
// 2. Renders an animated on-page indicator whenever an agent is controlling
//    this tab, so the user always has visual feedback — even on tabs they are
//    not currently looking at.
// ---------------------------------------------------------------------------

(function () {
  // -- Keepalive port ---------------------------------------------------------
  // We open a long-lived port to keep the MV3 service worker awake. The page
  // can enter the back/forward cache (bfcache) at any time, which closes the
  // port from Chrome's side and surfaces "message channel closed" errors if
  // we don't read chrome.runtime.lastError. Reconnect on bfcache restore.
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: "carrot-keepalive" });
      port.onDisconnect.addListener(() => {
        // Touch lastError so it isn't reported as unchecked.
        void chrome.runtime.lastError;
        port = null;
        setTimeout(connect, 5000 + Math.random() * 2000);
      });
    } catch {
      port = null;
      setTimeout(connect, 30000);
    }
  }
  connect();

  // When the page is restored from bfcache, the port has already been torn
  // down; re-open it immediately instead of waiting for the reconnect timer.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !port) connect();
  });
  window.addEventListener("pagehide", (e) => {
    if (e.persisted && port) {
      try { port.disconnect(); } catch {}
      port = null;
    }
  });

  // -- Overlay ---------------------------------------------------------------
  const HOST_ID = "__carrot_overlay_host__";
  let hostEl = null;
  let shadow = null;
  let pillEl = null;
  let actionEl = null;
  let ringEl = null;
  let hideTimer = null;
  let fadeTimer = null;

  function ensureOverlay() {
    if (hostEl && document.body && document.body.contains(hostEl)) return;
    if (!document.body) return;
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost?.parentNode) existingHost.parentNode.removeChild(existingHost);
    hostEl = document.createElement("div");
    hostEl.id = HOST_ID;
    // fixed host container with zero layout impact; shadow DOM isolates styles
    hostEl.style.cssText = `
      all: initial;
      position: fixed;
      top: 14px;
      right: 14px;
      z-index: 2147483647;
      pointer-events: none;
    `;
    shadow = hostEl.attachShadow({ mode: "closed" });
    shadow.innerHTML = /* html */ `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .pill {
          all: initial;
          pointer-events: auto;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 7px 12px 7px 9px;
          background: rgba(15,15,15,0.94);
          color: #f5f5f5;
          border: 1px solid rgba(250,205,42,0.35);
          border-radius: 999px;
          font-family: ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
          font-size: 12px;
          font-weight: 500;
          letter-spacing: 0;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow:
            0 8px 32px rgba(0,0,0,0.4),
            0 0 0 3px rgba(250,205,42,0.08),
            inset 0 1px 0 rgba(255,255,255,0.06);
          opacity: 0;
          transform: translateY(-10px) scale(0.96);
          transition: opacity 260ms cubic-bezier(0.16,1,0.3,1),
                      transform 420ms cubic-bezier(0.34,1.56,0.64,1);
          cursor: default;
          max-width: 320px;
          overflow: hidden;
        }
        .pill.show {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        .logo {
          position: relative;
          width: 20px;
          height: 20px;
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #facd2a;
        }
        .logo svg {
          width: 16px;
          height: 16px;
          animation: float 3s ease-in-out infinite;
        }
        .ring {
          position: absolute;
          inset: -3px;
          border-radius: 50%;
          border: 1.5px solid #facd2a;
          opacity: 0;
          animation: ping 1.6s cubic-bezier(0.16,1,0.3,1) infinite;
        }
        @keyframes ping {
          0%   { opacity: 0.8; transform: scale(0.8); }
          80%  { opacity: 0;   transform: scale(1.8); }
          100% { opacity: 0;   transform: scale(1.8); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-1.5px); }
        }
        .text {
          display: flex;
          flex-direction: column;
          line-height: 1.1;
        }
        .brand {
          font-weight: 700;
          font-size: 11px;
          letter-spacing: 0.02em;
          color: #facd2a;
        }
        .action {
          font-size: 10.5px;
          color: rgba(245,245,245,0.72);
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          margin-top: 1px;
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity 220ms ease, transform 240ms cubic-bezier(0.16,1,0.3,1);
        }
        .action.show {
          opacity: 1;
          transform: translateY(0);
        }
      </style>
      <div class="pill" id="pill" role="status" aria-live="polite">
        <div class="logo">
          <div class="ring" id="ring"></div>
          <svg viewBox="0 0 375 375" aria-hidden="true">
            <path fill="currentColor" d="M188.42 143.65c2.1 0 4.2.03 6.31.08 13.75.38 25.82 2.7 40.97 8.81 11.55 4.66 17.3 13.45 16.88 27.68-.36 11.98-3.09 23.41-6.17 35.56-.84 3.33-3.95 14.79-8 28.51H190.47a7.6 7.6 0 0 0-7.6 7.6 7.6 7.6 0 0 0 7.6 7.59h43.34c-2.12 6.77-4.35 13.6-6.58 19.94-4.61 13.16-8.39 22.64-13.89 36.06-2.98 7.27-6.7 16.58-10.55 24.71-1.06 2.23-3.41 8.96-7.83 12.57-4.2 3.43-9.27 3.2-13.14 0-4.4-3.64-6.77-10.34-7.83-12.57-3.85-8.13-7.58-17.44-10.55-24.71-1.6-3.88-3.02-7.4-4.39-10.81h26.54a7.6 7.6 0 0 0 7.59-7.6 7.6 7.6 0 0 0-7.6-7.59H153.2c-1.19-3.19-2.38-6.49-3.63-10.06-8.75-24.96-17.64-57.6-19.18-63.65-.14-.56-.28-1.12-.42-1.68h55.24a7.6 7.6 0 0 0 7.6-7.6 7.6 7.6 0 0 0-7.6-7.59h-58.73c-1.21-6.2-2.07-12.36-2.26-18.68-.43-14.23 5.33-23.02 16.88-27.68 15.16-6.11 27.21-8.5 40.97-8.82 2.14-.04 4.25-.07 6.35-.07zM212.36 20.78s-17.5 5.14-30.29 22.79c-8.14 11.25-9.96 24.62-10.21 32.85 8.97 9.48 14.8 21.83 17.49 34.57 4.31-12.85 13.84-23.87 25.95-29.97 1.71-.91 3.47-1.68 5.26-2.36 2.67-8.22 4.51-17.34 3.75-25.66-1.81-19.73-11.95-32.23-11.95-32.23zM120.27 64.24c-.79 0-1.5.01-2.11.03-4.86.14-5.42 0-5.42 0s-1.94 18.48 3.76 32.93c4.81 12.2 16.95 25.98 34.59 32.93 13.43 5.28 26.24 4.23 31.95 4.23 0 0 1.53-14.8-4.86-32.02-6.4-17.23-19.04-28.07-31.54-33.07-10.94-4.38-20.82-5.03-26.37-5.03zM240.06 83.55c-6.13.08-14.77 1.09-22.28 5.31-13.33 7.5-19.72 17.79-22.5 28.9-2.78 11.12-1.53 15.84-1.53 15.84s7.36 1.8 18.06-.42c10.7-2.22 20-7.23 28.48-18.48 8.47-11.25 7.78-30.7 7.78-30.7s-3.25-.5-8.01-.45z"/>
          </svg>
        </div>
        <div class="text">
          <div class="brand">Agent active</div>
          <div class="action" id="action"></div>
        </div>
      </div>
    `;
    document.body.appendChild(hostEl);
    pillEl = shadow.getElementById("pill");
    actionEl = shadow.getElementById("action");
    ringEl = shadow.getElementById("ring");
  }

  function showOverlay(actionText) {
    ensureOverlay();
    if (!pillEl) return;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    const pill = pillEl;
    requestAnimationFrame(() => {
      pill?.classList?.add("show");
    });

    if (actionText && actionEl) {
      const action = actionEl;
      action.classList?.remove("show");
      // brief reflow to re-trigger animation
      void action.offsetWidth;
      action.textContent = actionText;
      requestAnimationFrame(() => {
        action?.classList?.add("show");
      });
    }

    // Auto-hide after a period of inactivity
    hideTimer = setTimeout(() => hideOverlay(), 6500);
  }

  function hideOverlay() {
    if (!pillEl) return;
    pillEl.classList?.remove("show");
    fadeTimer = setTimeout(() => {
      if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
      hostEl = null;
      shadow = null;
      pillEl = null;
      actionEl = null;
    }, 500);
  }

  // -- Message listener -------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "carrot_tab_control") {
      if (msg.active) {
        showOverlay(msg.label || "");
      } else {
        hideOverlay();
      }
    }
  });
})();
