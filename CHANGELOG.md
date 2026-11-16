# Changelog

All notable user-facing changes to Carrot Browser should be documented here.

This project uses semantic versioning for the Chrome extension version in
`manifest.json`.

## Unreleased

- No unreleased changes recorded yet.

## 0.5.2 - 2026-11-16

- `navigate`, `goBack`, `goForward`, `reloadTab`, and `createTab` now wait for
  the new page to finish loading before returning, so the next command runs
  against the new document. They return the final URL, title, and whether the
  load finished. New optional `waitUntil` (`load` by default,
  `domcontentloaded`, or `none`) and `timeoutMs` (default 20 seconds). Failed
  loads report `navigationError`; slow ones report `timedOut`.
- Screenshots now report the image size, the CSS viewport size,
  devicePixelRatio, scroll offset, and the factor that maps image pixels to
  `clickAt` coordinates. New optional `maxWidth` downscales the image.
- The MCP `take_screenshot` tool returns the screenshot as an MCP image
  (PNG, 1280 px wide at most by default, `max_width` to change it) instead of
  a long data URL in text.
- `press` sends trusted key events through the Chrome debugger and accepts
  shortcuts such as `Shift+Tab` and `Meta+v`. On macOS, `Meta+a/c/x/v/z` and
  `Shift+Meta+z` now perform select all, copy, cut, paste, undo, and redo,
  which fixes pasting into code editors. Chrome briefly shows its "started
  debugging this browser" bar while a key is pressed, as it already did for
  `clickAt` and tab screenshots.
- When the debugger is unavailable or the target cannot take focus, `press`
  falls back to synthetic events that now carry the parsed key, `code`,
  modifier flags, and the legacy `keyCode`, `which`, and `charCode` values a
  real key press has. `keypress` fires only for keys that type text, as in
  Chrome.
- `execute` works on pages whose Content Security Policy blocks eval, such as
  claude.ai, by retrying the top frame through the Chrome debugger. Errors say
  when that fallback is not possible.
- `formInput` on a `<select>` returns the value read shortly after the change
  event, so React-controlled selects report the value they settled on.
- Bridge: `POST /navigate` accepts `waitUntil` and `timeoutMs`, `GET /screenshot`
  accepts `maxWidth`, and `POST /cmd` extends its timeout for navigation
  commands with a long `timeoutMs`. The standalone MCP adapter in `mcp-server/`
  has the same tool changes.
- Bridge: logs no longer contain the extension's `browser_token`. The bridge
  replaces the values of `browser_token`, `session_token`, `token`, `key`,
  `secret`, `password`, and similar query parameters with `[REDACTED]` in
  access and application logs.
- No permission or privacy changes. The extension and bridge work with older
  versions of each other. Load waiting, shortcuts, the eval fallback, and the
  select fix need extension 0.5.2; MCP image screenshots need the 0.5.2
  bridge; downscaled screenshots with viewport details need both.

## 0.5.1 - 2026-10-10

- Fixed the extension staying "connected" to a dead bridge connection after the
  computer sleeps or changes networks. It now checks that the bridge is still
  answering and reconnects within seconds instead of minutes.
- A pairing request made while the connection is down is resent automatically
  once the extension reconnects.
- "Pair an Agent" now waits for the pairing code and shows "Bridge unreachable"
  if none arrives, instead of silently resetting after 3 seconds.
- No permission, privacy, or bridge server changes.

## 0.5.0 - 2026-07-28

- Added iframe / frame-targeted actions so agents can click, type, fill, hover,
  and execute inside iframes via `frameSelector`, `frameId`, or `allFrames`.
- Added `resolveFrame` to map an iframe CSS selector to a Chrome `frameId`.
- Added the `webNavigation` permission (used to resolve iframe frame IDs).
- Pairing "copy prompt" now mentions MCP if installed, in addition to the skill.
- Improved public packaging: downloadable extension zip, changelog, and
  development conduct docs.
- Bridge and MCP surfaces updated for the same frame-targeting APIs.

## 0.4.4 - 2026-04-30

- Initial public Chrome Web Store packaging work.
- Added open-source privacy policy and hosted `/privacy` route.
- Added self-hosting Docker and Fly.io deployment documentation.
