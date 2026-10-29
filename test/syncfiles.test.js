'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../lib/syncfiles');

function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redundancy-sync-'));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
}

test('only plain paths inside iobroker-data are synced; the databases and iobroker.json never', () => {
    assert.deepStrictEqual(S.checkPaths(['history', 'backup-objects/x', ' sqlite.db ']), { ok: ['history', 'backup-objects/x', 'sqlite.db'], refused: [] });
    const r = S.checkPaths(['../etc', '/etc/passwd', 'C:\\Windows', 'iobroker.json', 'objects.jsonl', 'states.json', 'history/../../x', '', 'files']);
    assert.deepStrictEqual(r.ok, []);
    assert.strictEqual(r.refused.length, 9);
    assert.ok(r.refused.every(x => x.why), 'each says why');
    assert.match(r.refused.find(x => x.path === 'files').why, /Redis/);
});

test('the files of the listed paths, with size and time, relative to iobroker-data', () => {
    const root = tree({ 'history/a.json': 'aa', 'history/sub/b.json': 'bbb', 'other/c': 'c' });
    const l = S.listFiles(root, ['history']);
    assert.deepStrictEqual(l.files.map(f => [f.path, f.size]), [['history/a.json', 2], ['history/sub/b.json', 3]]);
    assert.strictEqual(l.total, 5);
    assert.deepStrictEqual(S.listFiles(root, ['nothing-here']).files, [], 'a path that does not exist is empty');
});

test('too big is refused before anything is copied', () => {
    const root = tree({ 'big/a': 'x'.repeat(50), 'big/b': 'y'.repeat(50) });
    assert.throws(() => S.listFiles(root, ['big'], { maxFile: 40 }), /a: 50 bytes, more than 40/);
    assert.throws(() => S.listFiles(root, ['big'], { maxTotal: 80 }), /100 bytes, more than 80/);
});

test('what the target lacks or has older or of another size', () => {
    const src = [{ path: 'h/a', size: 2, mtimeMs: 2000 }, { path: 'h/b', size: 3, mtimeMs: 2000 }, { path: 'h/c', size: 1, mtimeMs: 2000 }, { path: 'h/d', size: 1, mtimeMs: 2000 }];
    const dst = [{ path: 'h/b', size: 4, mtimeMs: 2000 }, { path: 'h/c', size: 1, mtimeMs: 1000 }, { path: 'h/d', size: 1, mtimeMs: 3000 }, { path: 'h/x', size: 1, mtimeMs: 1 }];
    assert.deepStrictEqual(S.diff(src, dst), [
        { path: 'h/a', size: 2, why: 'missing' },
        { path: 'h/b', size: 3, why: 'other size' },
        { path: 'h/c', size: 1, why: 'older' },
    ]);
});

test('a file written to the target lands under its root, and nowhere else', () => {
    const root = tree({});
    S.writeFile(root, 'history/a.json', Buffer.from('new'));
    assert.strictEqual(fs.readFileSync(path.join(root, 'history/a.json'), 'utf8'), 'new');
    assert.throws(() => S.writeFile(root, '../escape', Buffer.from('x')), /not a plain path/);
    assert.throws(() => S.writeFile(root, 'iobroker.json', Buffer.from('x')), /never synced/);
});
