// Module bootstrap for the options page.
// Lives in its own file so that extension MV3's strict CSP (which forbids
// inline scripts) doesn't reject it.
import { carrotLogo } from "./ui/logo.js";

document.getElementById("logoSlot").appendChild(carrotLogo(42));

try {
  const v = chrome.runtime.getManifest().version;
  document.getElementById("versionPill").textContent = `v${v}`;
} catch {}
