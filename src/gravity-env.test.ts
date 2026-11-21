import assert from "node:assert/strict";
import { agyEnv } from "./gravity-env.js";

const env = agyEnv({
  HOME: "/home/u", PATH: "/usr/bin", HTTPS_PROXY: "http://proxy:3128", SSL_CERT_FILE: "/etc/ca.pem", LANG: "C",
  OPENROUTER_API_KEY: "sk-secret", DSH_TOKEN: "t", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", AWS_SECRET_ACCESS_KEY: "s",
}, "/home/u/.local/bin", ":");
assert.equal(env.HOME, "/home/u");
assert.equal(env.PATH, "/usr/bin:/home/u/.local/bin");
assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
assert.equal(env.SSL_CERT_FILE, "/etc/ca.pem");
// No credential of DSH's or of another provider is handed to AGY.
for (const key of ["OPENROUTER_API_KEY", "DSH_TOKEN", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "AWS_SECRET_ACCESS_KEY"]) assert.equal(key in env, false, key);
// An unset variable stays unset (not the string "undefined").
assert.equal("DISPLAY" in env, false);
assert.equal(agyEnv({}, "/x", ":").PATH, "/x");
console.log("gravity env: ok");
