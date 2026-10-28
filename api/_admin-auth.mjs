import { createHmac, timingSafeEqual } from "node:crypto";
import { jsonResponse } from "./_campusvolt-redis.mjs";

const COOKIE_NAME = "campusvolt_admin";
const SESSION_SECONDS = 30 * 60;

function secret() {
  return `${process.env.CAMPUSVOLT_ADMIN_PASSWORD || ""}:${process.env.CAMPUSVOLT_STATION_API_KEY || ""}`;
}

function signature(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map((part) => {
    const separator = part.indexOf("=");
    return separator < 0
      ? [part.trim(), ""]
      : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))];
  }).filter(([name]) => name));
}

export function adminConfigured() {
  return Boolean(process.env.CAMPUSVOLT_ADMIN_PASSWORD && process.env.CAMPUSVOLT_STATION_API_KEY);
}

export function verifyAdminPassword(value) {
  return adminConfigured() && safeEqual(value, process.env.CAMPUSVOLT_ADMIN_PASSWORD);
}

export function createAdminToken(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_SECONDS * 1000 })).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function isAdminAuthorized(request, now = Date.now()) {
  if (!adminConfigured()) return false;
  const token = cookies(request)[COOKIE_NAME] || "";
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = token.slice(0, separator);
  if (!safeEqual(token.slice(separator + 1), signature(payload))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(decoded.exp) > now;
  } catch {
    return false;
  }
}

export function requireAdmin(request) {
  return isAdminAuthorized(request) ? null : jsonResponse(401, { error: "Administrator authorization is required." });
}

export function adminCookie(request, token, maxAge = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
