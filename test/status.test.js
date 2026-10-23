'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { statusToStates, installCommand, STALE_MS } = require('../lib/status');

const fresh = {
    t: 1_000_000,
    me: 'A',
    role: 'primary',
    epoch: 11,
    master: '192.168.64.11:6379',
    peer: 'Ok',
    myRedisOk: true,
    masterRedisOk: true,
};

test('a fresh status file gives the role, master, epoch and peer', () => {
    assert.deepStrictEqual(statusToStates(fresh, fresh.t + 500), {
        'info.connection': true,
        role: 'primary',
        primary: '192.168.64.11:6379',
        epoch: 11,
        peer: 'Ok',
    });
});

test('a stale or missing status means the watchdog is not running', () => {
    // the watchdog writes it every 250 ms; a host whose watchdog stopped is offline
    const old = statusToStates(fresh, fresh.t + STALE_MS + 1);
    assert.strictEqual(old['info.connection'], false);
    assert.strictEqual(old.role, 'offline');
    assert.strictEqual(statusToStates(null, 0).role, 'offline');
    assert.strictEqual(statusToStates({ role: 'primary' }, 5).role, 'offline', 'no timestamp');
});

test('no master known is an empty primary, not "null"', () => {
    assert.strictEqual(statusToStates({ ...fresh, master: null }, fresh.t).primary, '');
});

test('the install command fits the OS', () => {
    assert.strictEqual(
        installCommand('linux', '/opt/iobroker/node_modules/iobroker.redundancy/prebuilds/linux-x64/redundancy-watchdog', '/etc/scada/watchdog.json'),
        'sudo "/opt/iobroker/node_modules/iobroker.redundancy/prebuilds/linux-x64/redundancy-watchdog" install "/etc/scada/watchdog.json"',
    );
    assert.strictEqual(
        installCommand('darwin', '/w', '/c.json'),
        'sudo "/w" install "/c.json"',
    );
    assert.strictEqual(
        installCommand('win32', 'C:\\iob\\redundancy-watchdog.exe', 'C:\\ProgramData\\SCADA\\watchdog.json'),
        '"C:\\iob\\redundancy-watchdog.exe" install "C:\\ProgramData\\SCADA\\watchdog.json"   (admin shell)',
    );
});
