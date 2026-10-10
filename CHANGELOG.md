# Changelog

All notable user-facing changes to Carrot Browser should be documented here.

This project uses semantic versioning for the Chrome extension version in
`manifest.json`.

## Unreleased

- No unreleased changes recorded yet.

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
