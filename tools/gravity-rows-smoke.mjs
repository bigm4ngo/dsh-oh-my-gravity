// Check that recorded ACP tool events produce a restorable log in the installed DSH.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gravityToolRows } from '../lib/server/gravity-tool-rows.js';

const dshPackage = process.argv[2];
assert.ok(dshPackage && isAbsolute(dshPackage), 'usage: node tools/gravity-rows-smoke.mjs /path/to/dsh/package.json');
const requireDsh = createRequire(dshPackage);
const { Session, SessionId } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-session')).href);
const id = SessionId('gravity-rows-smoke');
const session = Session.create(id);
session.append('turn/start', { turn: 1 });
session.append('step/start', { turn: 1, step: 0 });
const rows = gravityToolRows(session, 'antigravity', 'default');
assert.ok(rows);
rows.update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', name: 'read_file', rawInput: { path: 'fixture.txt' } });
rows.update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'synthetic marker' } }] });
rows.finish();
session.append('step/end', { turn: 1, step: 0 });
const snapshot = session.snapshotEvents();
assert.deepEqual(snapshot.slice(2, 5).map(({ type }) => type), ['assistant/message', 'tool/call', 'tool/result']);
assert.deepEqual(snapshot[4].sourceEventSeqs, [snapshot[3].seq]);
assert.equal(Session.create(id, snapshot, session.header).deriveMessages().length, 2);
console.log('Installed DSH accepted and restored fixture AGY tool rows');
