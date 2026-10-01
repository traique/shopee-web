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

function decodeTokenSegment(encoded) {
  if (!encoded || encoded.includes("/")) {
    return "";
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

export function tokenFromPath(pathname) {
  const prefix = "/cdp/";
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  return decodeTokenSegment(pathname.slice(prefix.length));
}

export function tokenFromVersionPath(pathname) {
  const prefix = "/cdp/";
  const suffixes = ["/json/version", "/json/version/"];
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  for (const suffix of suffixes) {
    if (pathname.endsWith(suffix)) {
      return decodeTokenSegment(pathname.slice(prefix.length, -suffix.length));
    }
  }
  return "";
}
