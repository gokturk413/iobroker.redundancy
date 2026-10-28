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
        maintenanceUntil: 0,
        watchdogHost: 'A',
        links: '[]',
    });
    assert.strictEqual(statusToStates({ ...fresh, maintenanceUntil: 1793034074471 }, fresh.t).maintenanceUntil, 1793034074471);
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

test('a switchover command is a host name, or JSON with the host and a reason', () => {
    const { parseSwitchCommand } = require('../lib/status');
    assert.deepStrictEqual(parseSwitchCommand(' B '), { to: 'B', reason: '' });
    assert.deepStrictEqual(parseSwitchCommand('{"to":"B","reason":"Windows updates on A"}'), { to: 'B', reason: 'Windows updates on A' });
    assert.strictEqual(parseSwitchCommand(''), null);
    assert.strictEqual(parseSwitchCommand('{"reason":"no target"}'), null);
    assert.strictEqual(parseSwitchCommand('{broken'), null, 'JSON that does not parse is not a host name either');
    assert.strictEqual(parseSwitchCommand('{"to":"B","reason":"' + 'x'.repeat(600) + '"}').reason.length, 500);
});

test('the links state changes only when a link is lost or back, not with every beat', () => {
    const at = (age, lost) => statusToStates({ ...fresh, links: [{ name: 'lan', ageMs: age, lost }, { name: 'p2p', ageMs: 3, lost: false }] }, fresh.t);
    assert.strictEqual(at(20, false).links, at(40, false).links, 'the age is not in it');
    assert.notStrictEqual(at(20, false).links, at(400, true).links);
    assert.deepStrictEqual(JSON.parse(at(400, true).links), [{ name: 'lan', lost: true }, { name: 'p2p', lost: false }]);
    assert.strictEqual(statusToStates(fresh, fresh.t).links, '[]');
});

test('a settings message from the tab: an object of settings, and whether it is a dry run', () => {
    const { parseSettingsMessage } = require('../lib/status');
    assert.deepStrictEqual(parseSettingsMessage({ settings: { beatMs: 40 }, dryRun: true }), { settings: { beatMs: 40 }, dryRun: true });
    assert.deepStrictEqual(parseSettingsMessage({ settings: { beatMs: 40 } }), { settings: { beatMs: 40 }, dryRun: false });
    assert.strictEqual(parseSettingsMessage({ settings: [] }), null);
    assert.strictEqual(parseSettingsMessage({ settings: 'x' }), null);
    assert.strictEqual(parseSettingsMessage(null), null);
    assert.strictEqual(parseSettingsMessage({ settings: { x: 'y'.repeat(4000) } }), null, 'longer than a watchdog request line');
});
