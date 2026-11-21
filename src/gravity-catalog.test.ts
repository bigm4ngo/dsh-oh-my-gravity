import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GravityAdapter } from "./gravity-adapter.js";

// Fake AGY, steered by files: `spawns` counts starts; `failfirst` makes the first start die; `v2` adds a model and slows session/new.
const dir = mkdtempSync(join(tmpdir(), "gravity-catalog-"));
const spawns = join(dir, "spawns"), v2 = join(dir, "v2"), failfirst = join(dir, "failfirst"), cache = join(dir, "catalog.json");
const script = String.raw`
const fs = require('fs'); const send = m => console.log(JSON.stringify({jsonrpc:'2.0',...m}));
const n = (fs.existsSync(process.env.SPAWNS) ? fs.readFileSync(process.env.SPAWNS,'utf8').length : 0);
fs.appendFileSync(process.env.SPAWNS, 'x');
if (fs.existsSync(process.env.FAILFIRST) && n === 0) process.exit(3);
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{protocolVersion:1}});
  if (m.method === 'session/new') {
    const models = [{modelId:'a-high',name:'A (High)'},{modelId:'a-low',name:'A (Low)'},{modelId:'b',name:'B'}];
    const extra = fs.existsSync(process.env.V2);
    if (extra) models.push({modelId:'new',name:'New'});
    return setTimeout(() => send({id:m.id,result:{sessionId:'s',_meta:{antigravity:{tier:{name:'Pro Test'}}},models:{currentModelId:'b',availableModels:models}}}), extra ? 500 : 0);
  }
});`;
const make = (extra: object = {}) => new GravityAdapter({
  command: process.execPath, args: ["-e", script], catalogFile: cache, catalogTtlMs: 1,
  env: { ...process.env, SPAWNS: spawns, V2: v2, FAILFIRST: failfirst }, ...extra,
}, () => process.cwd());
const ids = async (a: GravityAdapter) => (await a.listModels("antigravity")).map((m) => m.id);
const started = () => (existsSync(spawns) ? readFileSync(spawns, "utf8").length : 0);

// Concurrent cold requests share one AGY start.
let a = make();
const lists = await Promise.all([ids(a), ids(a), ids(a), ids(a), ids(a)]);
assert.deepEqual(lists, Array(5).fill(["default", "a", "b"]));
assert.equal(started(), 1);

// The Settings page opens from what is known: no AGY start while a list is held; "fresh" asks AGY anew.
const quiet = make({ catalogTtlMs: 600_000 });
await ids(quiet);
await new Promise((r) => setTimeout(r, 1200)); // a list loaded from disk is refreshed once in the background; let that finish
const before = started();
const t00 = Date.now();
const known = await quiet.catalogStatus({ fresh: false });
assert.equal(known.models.length, 2);
assert.equal(known.signedIn, true);
assert.equal(known.plan, 'Pro Test'); // AGY's own tier name, kept with the list
assert.equal(started(), before);
assert.ok(Date.now() - t00 < 100);
assert.equal((await quiet.catalogStatus({ fresh: true })).signedIn, true);
assert.equal(started(), before + 1);
await quiet.close();

// A stale list is answered at once and refreshed behind the picker, never made to wait for AGY.
writeFileSync(v2, "");
const t0 = Date.now();
assert.deepEqual(await ids(a), ["default", "a", "b"]);
assert.ok(Date.now() - t0 < 300, "stale answer waited for AGY");
for (let i = 0; i < 40 && !(await ids(a)).includes("new"); i++) await new Promise((r) => setTimeout(r, 100)); // the refresh lands in the background
assert.deepEqual(await ids(a), ["default", "a", "b", "new"]);
await a.close();

// A new process shows the last good list immediately, even when AGY will not start.
const dead = make({ args: ["-e", "process.exit(3)"] });
assert.deepEqual(await ids(dead), ["default", "a", "b", "new"]);
assert.equal((await dead.catalogStatus({ fresh: false })).plan, "Pro Test"); // and it survives a restart
await dead.close();

// One failed start is retried before the picker gives up.
for (const f of [cache, spawns, v2]) rmSync(f, { force: true });
writeFileSync(failfirst, "");
const retrying = make();
assert.deepEqual(await ids(retrying), ["default", "a", "b"]);
await retrying.close();
// Failures are reported, not swallowed.
const noted: string[] = [];
const loud = make({ args: ["-e", "process.exit(3)"], log: (m: string) => noted.push(m) });
rmSync(cache, { force: true });
await ids(loud);
assert.ok(noted.some((m) => /model list/i.test(m)), JSON.stringify(noted));
await loud.close();
console.log("gravity catalog: ok");
