import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { bookmarkletUrl } from "../build-utils.mjs";

test("Compact Favourite encoding preserves percent signs, fragments, Unicode and URL punctuation", () => {
  const value = '100% %23 # room & café 😊 ? next=a+b "quoted"\nnext line';
  const script = "(()=>{globalThis.result=" + JSON.stringify(value) + "})()";
  const favourite = bookmarkletUrl(script);
  const url = new URL(favourite);
  assert.equal(url.hash, "");
  const decoded = decodeURIComponent(url.href.slice("javascript:".length));
  assert.equal(decoded, script);
  const context = {};
  runInNewContext(decoded, context, { codeGeneration: { strings: false, wasm: false } });
  assert.equal(context.result, value);
  assert.ok(favourite.length < ("javascript:" + encodeURIComponent(script)).length);
});

test("Literal percent escapes are encoded once, so decoding never changes script content", () => {
  const script = 'globalThis.result="%3B%0A%23%25";';
  const context = {};
  runInNewContext(decodeURIComponent(bookmarkletUrl(script).slice(11)), context);
  assert.equal(context.result, "%3B%0A%23%25");
});
