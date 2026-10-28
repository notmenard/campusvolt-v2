import {
  adminConfigured,
  adminCookie,
  createAdminToken,
  isAdminAuthorized,
  verifyAdminPassword,
} from "./_admin-auth.mjs";
import { jsonResponse } from "./_campusvolt-redis.mjs";

function response(status, payload, cookie) {
  const result = jsonResponse(status, payload);
  if (cookie) result.headers.set("Set-Cookie", cookie);
  return result;
}

export async function GET(request) {
  return jsonResponse(200, {
    configured: adminConfigured(),
    authorized: isAdminAuthorized(request),
  });
}

export async function POST(request) {
  if (!adminConfigured()) {
    return jsonResponse(503, { error: "CAMPUSVOLT_ADMIN_PASSWORD is not configured on the server." });
  }
  let input;
  try {
    input = await request.json();
  } catch {
    return jsonResponse(400, { error: "A JSON request body is required." });
  }
  if (!verifyAdminPassword(String(input.password || ""))) {
    return jsonResponse(401, { error: "Incorrect administrator password." });
  }
  const token = createAdminToken();
  return response(200, { authorized: true, expiresInSeconds: 1800 }, adminCookie(request, token));
}

export async function DELETE(request) {
  return response(200, { authorized: false }, adminCookie(request, "", 0));
}
