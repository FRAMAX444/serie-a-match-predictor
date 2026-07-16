import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  ADMIN_PASSWORD_SHA256,
  ADMIN_USERNAME,
  adminAuthSupported,
  sha256,
  verifyCredentials,
} from "../admin-auth.js";

const sampleHash = await sha256("password-di-test", webcrypto);
assert.equal(sampleHash.length, 64);
assert.match(ADMIN_PASSWORD_SHA256, /^[a-f0-9]{64}$/);
assert.ok(ADMIN_USERNAME.length > 0);
assert.equal(await verifyCredentials("TestAdmin", "password-di-test", {
  username: "testadmin",
  passwordHash: sampleHash,
  cryptoProvider: webcrypto,
}), true);
assert.equal(await verifyCredentials("TestAdmin", "password-errata", {
  username: "testadmin",
  passwordHash: sampleHash,
  cryptoProvider: webcrypto,
}), false);
assert.equal(adminAuthSupported(webcrypto), true);

console.log("OK: flusso autenticazione admin verificato");
