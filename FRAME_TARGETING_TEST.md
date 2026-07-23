# Frame Targeting Manual Test

Use this to verify `resolveFrame`, frame-targeted action injection, `execute` in
an iframe, `clickAt`, and screenshot `tabId` targeting.

## Setup

1. Load this repo as the unpacked Chrome extension.
2. Start a local static server from the repo root:

   ```bash
   python3 -m http.server 8787
   ```

3. Open `http://127.0.0.1:8787/frame-targeting-test.html` in Chrome.
4. Get the tab id from `GET /tabs` or the Carrot side panel.

## Commands

Replace `123` with the tab id.

```json
{"type":"resolveFrame","tabId":123,"frameSelector":"#tinyMCE5448_ifr"}
```

Expected: a result containing a numeric `frameId` and `matchedBy`.

```json
{"type":"execute","tabId":123,"frameSelector":"#tinyMCE5448_ifr","script":"document.title"}
```

Expected: `"Editor Frame Fixture"`.

```json
{"type":"formInput","tabId":123,"frameSelector":"#tinyMCE5448_ifr","selector":"#editor","value":"Hello from frame targeting"}
```

Expected: the iframe editor shows `Hello from frame targeting`.

```json
{"type":"click","tabId":123,"frameSelector":"#tinyMCE5448_ifr","selector":"#inside-frame"}
```

Expected: the iframe status changes to `Clicked inside iframe`.

```json
{"type":"clickAt","tabId":123,"x":120,"y":300}
```

Expected: Chrome dispatches a debugger click at the page coordinate. Adjust `x`
and `y` to hit the iframe button if your viewport differs.

```text
GET /screenshot?tabId=123
```

Expected: the screenshot is from tab `123`, even if another tab is active.
