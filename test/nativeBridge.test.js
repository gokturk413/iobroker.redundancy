'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const bridge = require('../lib/nativeBridge');

function fakePackage() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redundancy-bridge-'));
    for (const rid of bridge.RIDS) {
        const dir = path.join(root, 'prebuilds', rid);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'redundancy.node.gz'), zlib.gzipSync(`addon ${rid}`));
        fs.writeFileSync(path.join(dir, bridge.watchdogName(rid) + '.gz'), zlib.gzipSync(`watchdog ${rid}`));
    }
    return root;
}

test('each supported host maps to its prebuild folder', () => {
    assert.strictEqual(bridge.ridFor('win32', 'x64'), 'win-x64');
    assert.strictEqual(bridge.ridFor('linux', 'x64'), 'linux-x64');
    assert.strictEqual(bridge.ridFor('linux', 'arm64'), 'linux-arm64');
    assert.strictEqual(bridge.ridFor('darwin', 'arm64'), 'osx-arm64');
    assert.strictEqual(bridge.ridFor('darwin', 'x64'), 'osx-x64');
    assert.strictEqual(bridge.ridFor('freebsd', 'x64'), null);
    assert.deepStrictEqual(bridge.RIDS, ['win-x64', 'linux-x64', 'linux-arm64', 'osx-arm64', 'osx-x64']);
});

test('the watchdog is an .exe only on Windows', () => {
    assert.strictEqual(bridge.watchdogName('win-x64'), 'redundancy-watchdog.exe');
    assert.strictEqual(bridge.watchdogName('osx-arm64'), 'redundancy-watchdog');
});

test('only the files of this host are expanded', () => {
    const root = fakePackage();
    const rid = 'linux-arm64';
    const w = bridge.watchdogPath({ root, rid });
    assert.strictEqual(fs.readFileSync(w, 'utf8'), `watchdog ${rid}`);
    const expanded = fs
        .readdirSync(path.join(root, 'prebuilds'), { recursive: true })
        .filter(f => !String(f).endsWith('.gz') && fs.statSync(path.join(root, 'prebuilds', f)).isFile());
    assert.deepStrictEqual(expanded.map(f => path.normalize(String(f))), [path.join(rid, 'redundancy-watchdog')]);
});

test('the expanded watchdog can be run', { skip: process.platform === 'win32' }, () => {
    const root = fakePackage();
    const w = bridge.watchdogPath({ root, rid: 'linux-x64' });
    assert.strictEqual(fs.statSync(w).mode & 0o755, 0o755);
});

test('a newer expanded file is kept, an older one is replaced', () => {
    const root = fakePackage();
    const rid = 'osx-x64';
    const w = bridge.watchdogPath({ root, rid });
    fs.writeFileSync(w, 'kept');
    assert.strictEqual(fs.readFileSync(bridge.watchdogPath({ root, rid }), 'utf8'), 'kept');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(w, old, old);
    assert.strictEqual(fs.readFileSync(bridge.watchdogPath({ root, rid }), 'utf8'), `watchdog ${rid}`);
});

test('a host without a prebuild gets a clear error', () => {
    const root = fakePackage();
    assert.throws(() => bridge.watchdogPath({ root, rid: null }), /not supported/);
    fs.rmSync(path.join(root, 'prebuilds', 'win-x64'), { recursive: true });
    assert.throws(() => bridge.watchdogPath({ root, rid: 'win-x64' }), /redundancy-watchdog\.exe\.gz/);
});
