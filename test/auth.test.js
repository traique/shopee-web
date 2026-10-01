import test from "node:test";
import assert from "node:assert/strict";

import { normalizeToken, tokenFromPath, tokenMatches } from "../src/auth.js";

test("normalizes surrounding whitespace only", () => {
  assert.equal(normalizeToken("  abc  "), "abc");
});

test("token comparison requires same non-empty value", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secret", "other"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("secret", "secret2"), false);
});

test("extracts exactly one encoded token path segment", () => {
  assert.equal(tokenFromPath("/cdp/abc%20123"), "abc 123");
  assert.equal(tokenFromPath("/cdp/abc/extra"), "");
  assert.equal(tokenFromPath("/healthz"), "");
  assert.equal(tokenFromPath("/cdp/"), "");
});
