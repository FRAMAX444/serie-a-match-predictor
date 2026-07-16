export const ADMIN_USERNAME = "RC25M";
export const ADMIN_PASSWORD_SHA256 = "ba8a8700eed325f42283bae17c64cff6957735c049991fb33ee2e3d4e5c59eb4";

export async function sha256(value, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error("Hash non disponibile");
  const bytes = new TextEncoder().encode(String(value));
  const digest = await cryptoProvider.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(left, right) {
  const first = String(left);
  const second = String(right);
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyCredentials(username, password, configuration = {}) {
  const expectedUsername = configuration.username || ADMIN_USERNAME;
  const expectedHash = configuration.passwordHash || ADMIN_PASSWORD_SHA256;
  const usernameMatches = String(username).trim().toLowerCase() === expectedUsername.toLowerCase();
  const suppliedHash = await sha256(password, configuration.cryptoProvider || globalThis.crypto);
  return usernameMatches && safeEqual(suppliedHash, expectedHash);
}

export function adminAuthSupported(cryptoProvider = globalThis.crypto) {
  return Boolean(cryptoProvider?.subtle && globalThis.TextEncoder);
}
