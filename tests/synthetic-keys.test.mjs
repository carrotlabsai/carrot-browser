// Run with: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Every chrome.* call returns the stub, and awaiting it never settles, so the
// service worker's startup code stalls instead of running.
const stub = new Proxy(function () {}, {
  get: (_target, prop) => (prop === "then" ? () => {} : stub),
  apply: () => stub,
  construct: () => stub,
});

class FakeKeyboardEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    for (const k of ["key", "code", "location", "shiftKey", "ctrlKey", "altKey", "metaKey"]) {
      Object.defineProperty(this, k, { value: init[k] });
    }
  }
  get keyCode() { return 0; }
  get which() { return 0; }
  get charCode() { return 0; }
}

const target = new EventTarget();
const context = vm.createContext({
  chrome: stub,
  WebSocket: stub,
  fetch: stub,
  console,
  URL,
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  KeyboardEvent: FakeKeyboardEvent,
  document: { activeElement: target, querySelector: () => null },
  window: {},
});
vm.runInContext(readFileSync(new URL("../background.js", import.meta.url), "utf8"), context);

function press(spec, os = "mac") {
  const events = context.syntheticKeyEvents(context.parseKeyCombo(spec, os));
  const seen = [];
  const record = (e) => seen.push({
    type: e.type, key: e.key, code: e.code, location: e.location,
    keyCode: e.keyCode, which: e.which, charCode: e.charCode,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
  });
  for (const type of ["keydown", "keypress", "keyup"]) target.addEventListener(type, record);
  try {
    context.dispatchSyntheticKeys(events, "", "");
  } finally {
    for (const type of ["keydown", "keypress", "keyup"]) target.removeEventListener(type, record);
  }
  return seen;
}

const codes = (seen) => seen.map((e) => [e.type, e.keyCode, e.which, e.charCode]);

test("Enter sends key code 13 and a keypress with char code 13", () => {
  assert.deepEqual(codes(press("Enter")), [
    ["keydown", 13, 13, 0], ["keypress", 13, 13, 13], ["keyup", 13, 13, 0],
  ]);
});

test("letters use the uppercase key code and the typed character code", () => {
  assert.deepEqual(codes(press("a")), [
    ["keydown", 65, 65, 0], ["keypress", 97, 97, 97], ["keyup", 65, 65, 0],
  ]);
  const shifted = press("Shift+a");
  assert.deepEqual(codes(shifted), [
    ["keydown", 65, 65, 0], ["keypress", 65, 65, 65], ["keyup", 65, 65, 0],
  ]);
  assert.ok(shifted.every((e) => e.key === "A" && e.shiftKey));
});

test("space, digits, and punctuation", () => {
  assert.deepEqual(codes(press("Space")), [
    ["keydown", 32, 32, 0], ["keypress", 32, 32, 32], ["keyup", 32, 32, 0],
  ]);
  assert.deepEqual(codes(press("7"))[1], ["keypress", 55, 55, 55]);
  assert.deepEqual(codes(press("Shift+/")), [
    ["keydown", 191, 191, 0], ["keypress", 47, 47, 47], ["keyup", 191, 191, 0],
  ]);
});

test("non-text keys get key codes and no keypress", () => {
  for (const [spec, code] of [
    ["Escape", 27], ["Tab", 9], ["Backspace", 8], ["Delete", 46], ["ArrowLeft", 37],
    ["PageDown", 34], ["Home", 36], ["F5", 116],
  ]) {
    assert.deepEqual(codes(press(spec)), [["keydown", code, code, 0], ["keyup", code, code, 0]], spec);
  }
});

test("shortcuts with Control, Alt, or Meta set flags and send no keypress", () => {
  const paste = press("Meta+v");
  assert.deepEqual(codes(paste), [["keydown", 86, 86, 0], ["keyup", 86, 86, 0]]);
  assert.ok(paste.every((e) => e.key === "v" && e.code === "KeyV" && e.metaKey && !e.ctrlKey));

  const select = press("Control+Shift+ArrowLeft", "linux");
  assert.deepEqual(codes(select), [["keydown", 37, 37, 0], ["keyup", 37, 37, 0]]);
  assert.ok(select.every((e) => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey));

  assert.ok(press("Mod+c", "win").every((e) => e.ctrlKey && e.keyCode === 67));
  assert.ok(press("Alt+x").every((e) => e.altKey && e.keyCode === 88));
});

test("modifier keys pressed alone use their key codes and the left location", () => {
  for (const [spec, code] of [["Shift", 16], ["Control", 17], ["Alt", 18], ["Meta", 91]]) {
    const seen = press(spec);
    assert.deepEqual(codes(seen), [["keydown", code, code, 0], ["keyup", code, code, 0]], spec);
    assert.ok(seen.every((e) => e.location === 1), spec);
  }
  assert.ok(press("Enter").every((e) => e.location === 0));
});
