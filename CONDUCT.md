# Development Conduct

This document describes how development should be done in this repository,
especially when preparing a new Chrome Web Store release.

Carrot is both a Chrome extension and a bridge server. A release can affect the
extension package, the hosted bridge, the public privacy policy, or all three.
Keep those surfaces in sync.

## General Principles

- Keep the extension's single purpose clear: user-authorized browser automation
  for AI agents.
- Prefer small, reviewable changes over broad rewrites.
- Do not add permissions unless they are required for the extension's single
  purpose.
- Do not add remotely executed JavaScript or WebAssembly to the extension.
- Keep privacy disclosures accurate whenever data handling changes.
- Keep the hosted bridge deployable from the same open-source code that users
  can inspect and self-host.
- Do not commit secrets, local production config, `.env` files, or generated
  release ZIPs.

## Release Checklist

Use this checklist whenever preparing a new extension version for the Chrome
Web Store.

### 1. Start From A Clean Baseline

```bash
git status --short --branch
git pull --ff-only
```

Confirm you are on the intended release branch and understand every modified or
untracked file before packaging.

### 2. Review The Change Set

Review the changes since the last release:

```bash
git log --oneline <last-release-tag>..HEAD
git diff <last-release-tag>...HEAD
```

Decide whether the release includes:

- Extension-only changes.
- Bridge server changes.
- Store listing asset changes.
- Permission, host permission, or privacy disclosure changes.

### 3. Update The Version

Update `manifest.json`:

- Bump `version` using semantic versioning.
- Keep `description`, `homepage_url`, permissions, host permissions, and content
  script matches accurate.
- Do not reuse a version number already uploaded to Chrome Web Store.

If the bridge server has user-visible API changes, note them in the changelog
as part of the same release.

### 4. Update The Changelog

Update `CHANGELOG.md` with a new version section:

- Version number and release date.
- User-visible extension changes.
- Bridge/API changes.
- Permission or privacy disclosure changes.
- Migration notes, if any.

Keep the changelog understandable to users and reviewers. Avoid internal-only
implementation detail unless it explains behavior or risk.

### 5. Re-check Permissions And Privacy

Before every Web Store upload, review `manifest.json` for:

- `permissions`
- `host_permissions`
- `content_scripts.matches`
- `web_accessible_resources`

For each permission, confirm it is still required for Carrot's single purpose.
Remove unused permissions before submitting.

Also review `PRIVACY.md` and the live hosted policy at:

```text
https://browser.carrotlabs.ai/privacy
```

Update the policy if the release changes what data the extension or bridge
handles, transmits, stores, or shares.

### 6. Check Remote Code Compliance

Chrome extensions must not execute remote code. Before packaging, search for
remote-code risks:

```bash
rg "eval\\(|new Function|import\\(|<script|WebAssembly|executeScript" \
  manifest.json background.js content.js options*.js options.html sidepanel ui
```

Packaged scripts and packaged modules are allowed. Remotely supplied JavaScript
strings, external script URLs, remotely loaded Wasm, or generic `eval` paths are
not acceptable for Web Store submission.

### 7. Validate Locally

Run basic validation:

```bash
python3 -m json.tool manifest.json >/tmp/carrot-manifest.json
python3 -m py_compile server.py
```

Load the unpacked extension in Chrome:

1. Open `chrome://extensions/`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select the repo root.
5. Exercise the side panel, options page, pairing flow, and representative
   browser commands.

If the release changes the hosted bridge, test the bridge locally or in a
staging/self-hosted environment before deploying production.

### 8. Rebuild Store Assets If Needed

If UI, branding, permissions, or the product story changed, regenerate or update
Chrome Web Store assets under `dist/webstore-assets/`.

Required sizes:

- Screenshots: `1280x800` or `640x400`, JPEG or 24-bit PNG with no alpha.
- Small promo tile: `440x280`, JPEG or 24-bit PNG with no alpha.
- Marquee promo tile: `1400x560`, JPEG or 24-bit PNG with no alpha.

Validate generated assets:

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha dist/webstore-assets/*.png
```

Do not commit generated store assets unless there is a specific reason to keep
them versioned.

### 9. Build The Web Store ZIP

Build the upload archive from the extension files only:

```bash
VERSION="$(python3 - <<'PY'
import json
print(json.load(open("manifest.json"))["version"])
PY
)"

mkdir -p dist
rm -f "dist/carrot-browser-${VERSION}.zip"
zip -r "dist/carrot-browser-${VERSION}.zip" \
  manifest.json \
  background.js \
  content.js \
  options.html options.js options-init.js \
  sidepanel ui assets LICENSE \
  -x "*.DS_Store" "__MACOSX/*"
```

Verify the ZIP:

```bash
zip -T "dist/carrot-browser-${VERSION}.zip"
unzip -l "dist/carrot-browser-${VERSION}.zip"
```

Confirm `manifest.json` is at the ZIP root and that server files, local deploy
config, `.env` files, repo metadata, and development artifacts are not included.

### 10. Commit, Tag, And Push

Stage the relevant source/doc changes, not generated ZIPs:

```bash
git status --short
git add manifest.json CHANGELOG.md README.md PRIVACY.md server.py \
  background.js content.js options.html options.js options-init.js \
  sidepanel ui assets DEPLOY.md Dockerfile deploy
git commit -m "Release v${VERSION}"
git tag "v${VERSION}"
git push
git push origin "v${VERSION}"
```

Adjust the `git add` list to match the actual files changed. Do not stage
ignored or local-only files accidentally.

### 11. Deploy The Bridge If Needed

If the release changes `server.py`, `PRIVACY.md`, `requirements.txt`,
`Dockerfile`, or anything else used by the hosted bridge, deploy the hosted
bridge separately from the extension upload.

For the Carrot Labs hosted bridge, use the private/local production Fly config,
not the example app name in `deploy/fly.example.toml`.

After deploy, verify:

```bash
curl -s https://browser.carrotlabs.ai/status
curl -I https://browser.carrotlabs.ai/privacy
curl -I https://browser.carrotlabs.ai/privacy.md
```

### 12. Create A GitHub Release

Create a GitHub release for the tag:

- Title: `vX.Y.Z`
- Body: summarize the `CHANGELOG.md` entry.
- Attach the Web Store ZIP if useful for auditability.

### 13. Submit To Chrome Web Store

In the Chrome Web Store Developer Dashboard:

1. Upload `dist/carrot-browser-${VERSION}.zip`.
2. Confirm Chrome accepts the manifest.
3. Update release notes from `CHANGELOG.md`.
4. Confirm screenshots and promo tiles are current.
5. Confirm permission justifications are accurate.
6. Confirm privacy data checkboxes still match `PRIVACY.md`.
7. Confirm the privacy policy URL is:

```text
https://browser.carrotlabs.ai/privacy
```

Submit for review.

### 14. Post-submit Checks

After submission or approval:

- Record the submitted version and submission date in `CHANGELOG.md` or the
  GitHub release notes if needed.
- Watch for Chrome Web Store review feedback.
- Verify the approved listing has the correct screenshots, description,
  privacy policy URL, and version.
- If rejected, fix the issue in source, bump the version if Chrome requires it,
  rebuild the ZIP, and resubmit.

## Release Blockers

Do not submit a release if any of these are true:

- The working tree contains unexplained changes.
- `manifest.json` is invalid JSON.
- The extension ZIP includes server-only, local-only, secret, or repo metadata
  files.
- The release introduces a permission without a clear user-facing need.
- The release introduces remote code execution in the Chrome extension.
- The privacy policy no longer matches the product's data handling.
- The hosted bridge health check fails after a required server deploy.
