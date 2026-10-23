'use strict';
// Runs against the real engine files of this host when they are in prebuilds/ (the deploy
// job pulls them from the engine release before `npm test`); skipped in a plain checkout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const bridge = require('../lib/nativeBridge');

const rid = bridge.ridFor(process.platform, process.arch);
const present = rid && fs.existsSync(path.join(__dirname, '..', 'prebuilds', rid, 'redundancy.node.gz'));

test('the addon of this host loads and checks client options', { skip: !present && 'no engine in prebuilds/' }, () => {
    const addon = bridge.loadAddon();
    assert.match(addon.version(), /^\d+\.\d+\.\d+/);
    const issues = JSON.parse(addon.checkClientOptions(JSON.stringify({ objects: { type: 'file' }, states: { type: 'file' } })));
    assert.deepStrictEqual(
        issues.map(i => [i.db, i.option, i.severity]),
        [
            ['objects', 'type', 'error'],
            ['states', 'type', 'error'],
        ],
    );
});

test('the watchdog of this host runs', { skip: !present && 'no engine in prebuilds/' }, () => {
    const out = execFileSync(bridge.watchdogPath(), ['--help'], { encoding: 'utf8' });
    assert.match(out, /redundancy-watchdog install <config\.json>/);
});
