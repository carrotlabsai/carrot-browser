# Changelog

All notable user-facing changes to Carrot Browser should be documented here.

This project uses semantic versioning for the Chrome extension version in
`manifest.json`.

## Unreleased

- No unreleased changes recorded yet.

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
