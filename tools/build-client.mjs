import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";

const root = process.cwd();
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const outDir = mkdtempSync(join(tmpdir(), "omg-client-build-"));

function collectJs(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJs(full, base));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      const rel = `./${relative(base, full).split("\\").join("/")}`;
      files.push({ rel, full });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

try {
  execFileSync(
    tsc,
    [
      "--ignoreConfig",
      join(root, "src", "client", "index.tsx"),
      "--outDir",
      outDir,
      "--module",
      "commonjs",
      "--moduleResolution",
      "bundler",
      "--target",
      "ES2022",
      "--jsx",
      "react-jsx",
      "--esModuleInterop",
      "--skipLibCheck",
      "--lib",
      "ES2023,DOM,DOM.Iterable",
      "--strict",
    ],
    { stdio: "inherit" },
  );

  const modules = collectJs(outDir);
  if (!modules.some((m) => m.rel === "./index.js")) {
    throw new Error("Compiled client output did not produce ./index.js");
  }

  const entries = modules.map(({ rel, full }) => {
    const code = readFileSync(full, "utf8");
    return `  ${JSON.stringify(rel)}: function(require, exports, module) {\n${code}\n  }`;
  });

  const bundle = `window.__ModuleLoader__.load({ id: "dsh-oh-my-gravity", factory: (hostRequire) => {
var __modules = {
${entries.join(",\n")}
};
var __cache = {};
function __dirnamePosix(id) {
  var i = id.lastIndexOf("/");
  return i <= 1 ? "." : id.slice(0, i);
}
function __resolve(fromId, spec) {
  if (!spec.startsWith(".")) return null;
  var joined = __dirnamePosix(fromId) + "/" + spec;
  var normalized = [];
  for (var part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  var candidate = "./" + normalized.join("/");
  if (__modules[candidate]) return candidate;
  if (__modules[candidate + ".js"]) return candidate + ".js";
  return candidate;
}
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  var fn = __modules[id];
  if (!fn) throw new Error("dsh-oh-my-gravity client module not found: " + id);
  var mod = __cache[id] = { exports: {} };
  fn(function(spec) {
    var local = __resolve(id, spec);
    if (local !== null) return __load(local);
    return hostRequire(spec);
  }, mod.exports, mod);
  return mod.exports;
}
return __load(${JSON.stringify("./" + posix.basename("index.js"))});
} });\n`;

  writeFileSync(join(root, "lib", "client.js"), bundle, "utf8");
  console.log(`Built lib/client.js (${modules.length} modules, ${Buffer.byteLength(bundle)} bytes)`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
