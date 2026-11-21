/** The environment AGY is started with: what it needs to find its login and reach Google, and nothing of DSH's (no provider keys). */
const FORWARDED = [
  "HOME", "USERPROFILE", "PATH", "SystemRoot", "LANG", "LC_ALL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY",
  // Network setup: without these AGY cannot reach Google from behind a proxy or a corporate CA.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

export function agyEnv(source: NodeJS.ProcessEnv, extraPath: string, delimiter: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED) if (source[key] !== undefined) env[key] = source[key];
  // The Google installer puts AGY in ~/.local/bin, which GUI and service PATHs may omit.
  env.PATH = [env.PATH, extraPath].filter(Boolean).join(delimiter);
  return env;
}
