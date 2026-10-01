import crypto from "node:crypto";

export function normalizeToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function tokenMatches(expected, actual) {
  const left = Buffer.from(normalizeToken(expected));
  const right = Buffer.from(normalizeToken(actual));
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function tokenFromPath(pathname) {
  const prefix = "/cdp/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    return "";
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}
