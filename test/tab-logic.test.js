'use strict';
const test = require('node:test');
const assert = require('node:assert');

const L = require('../admin/tab-logic');

const NOW = 1_793_040_000_000;
const st = val => ({ val, ack: true, ts: NOW - 1000 });

/** Two hosts as the adapter's states show them: A primary, B a ready standby. */
function pair(over = {}) {
    const states = {
        'redundancy.0.info.connection': st(true),
        'redundancy.0.role': st('primary'),
        'redundancy.0.watchdogHost': st('A'),
        'redundancy.0.primary': st('192.168.64.11:6379'),
        'redundancy.0.epoch': st(53),
        'redundancy.0.peer': st('Ok'),
        'redundancy.0.clientOptions': st('[]'),
        'redundancy.0.engineVersion': st('0.1.0'),
        'redundancy.0.maintenanceUntil': st(0),
        'redundancy.1.info.connection': st(true),
        'redundancy.1.role': st('standby'),
        'redundancy.1.watchdogHost': st('B'),
        'redundancy.1.primary': st('192.168.64.11:6379'),
        'redundancy.1.epoch': st(53),
        'redundancy.1.peer': st('Ok'),
        'redundancy.1.clientOptions': st('[{"db":"states","option":"keepAlive","found":"missing","needed":"1000","severity":"error"}]'),
        'redundancy.1.engineVersion': st('0.1.0'),
        'redundancy.1.maintenanceUntil': st(0),
        'redundancy.0.installedAdapters': st('{"modbus":"6.3.2","rockwell-enip":"0.2.1","mqtt":"7.0.0"}'),
        'redundancy.1.installedAdapters': st('{"modbus":"6.3.2","rockwell-enip":"0.2.0"}'),
        ...over,
    };
    const instances = [
        { n: '1', host: 'iobStansiya486_b' },
        { n: '0', host: 'iobStansiya486' },
    ];
    return L.servers(instances, states);
}

test('each host becomes a server card, sorted by its watchdog name', () => {
    const s = pair();
    assert.deepStrictEqual(
        s.map(x => [x.name, x.iobHost, x.role, x.connected, x.clientIssues]),
        [
            ['A', 'iobStansiya486', 'primary', true, 0],
            ['B', 'iobStansiya486_b', 'standby', true, 1],
        ],
    );
    assert.strictEqual(s[0].instance, 'redundancy.0');
});

test('redundant means one primary and a connected standby that sees it', () => {
    assert.strictEqual(L.summary(pair(), NOW).redundant, true);
    assert.strictEqual(L.summary(pair({ 'redundancy.1.peer': st('Lost') }), NOW).redundant, false);
    assert.strictEqual(L.summary(pair({ 'redundancy.1.info.connection': st(false) }), NOW).redundant, false);
    const two = L.summary(pair({ 'redundancy.1.role': st('primary') }), NOW);
    assert.strictEqual(two.redundant, false);
    assert.match(two.text, /2 primaries/);
});

test('the maintenance lock counts while its end is ahead', () => {
    assert.strictEqual(L.summary(pair({ 'redundancy.0.maintenanceUntil': st(NOW + 60_000) }), NOW).maintenanceUntil, NOW + 60_000);
    assert.strictEqual(L.summary(pair({ 'redundancy.0.maintenanceUntil': st(NOW - 1) }), NOW).maintenanceUntil, 0);
});

test('a switchover goes to a ready standby, sent through the primary host', () => {
    assert.deepStrictEqual(L.switchTargets(pair()), [{ name: 'B', via: 'redundancy.0' }]);
    assert.deepStrictEqual(L.switchTargets(pair({ 'redundancy.1.info.connection': st(false) })), [], 'its watchdog is not running');
    assert.deepStrictEqual(L.switchTargets(pair({ 'redundancy.0.role': st('standby') })), [], 'no primary: nothing to switch from');
});

test('events of all hosts are merged, newest first, each with its host', () => {
    const merged = L.mergeEvents(
        [
            { host: 'A', events: [{ t: 3, event: 'role', role: 'standby' }, { t: 1, event: 'api' }] },
            { host: 'B', events: [{ t: 2, event: 'switchover', to: '192.168.64.12:6379' }] },
        ],
        10,
    );
    assert.deepStrictEqual(
        merged.map(e => [e.t, e.host, e.event]),
        [
            [3, 'A', 'role'],
            [2, 'B', 'switchover'],
            [1, 'A', 'api'],
        ],
    );
    assert.strictEqual(L.mergeEvents([{ host: 'A', events: [{ t: 1 }, { t: 2 }, { t: 3 }] }], 2).length, 2);
});

test('events read as sentences with a level', () => {
    const d = e => L.describeEvent(e);
    assert.deepStrictEqual(d({ event: 'switchover', from: '192.168.64.12:6379', to: '192.168.64.11:6379', by: 'admin', stepsMs: { promoted: 1094 } }), {
        level: 'info',
        title: 'Planned switchover to 192.168.64.11:6379',
        detail: 'from 192.168.64.12:6379 · promoted in 1.09 s · by admin',
    });
    assert.strictEqual(d({ event: 'fence', why: 'lost its quorum' }).level, 'bad');
    assert.strictEqual(d({ event: 'failover-done', to: '192.168.64.12:6379', promotedMs: 1925 }).title, 'Failover to 192.168.64.12:6379');
    assert.strictEqual(d({ event: 'maintenance', minutes: 0 }).title, 'Maintenance lock lifted');
    assert.strictEqual(d({ event: 'maintenance', minutes: 60, by: 'admin' }).title, 'Maintenance lock for 60 min');
    assert.strictEqual(d({ event: 'alarm', what: 'B is cut off' }).level, 'warn');
    assert.strictEqual(d({ event: 'something-new', x: 1 }).title, 'something-new');
});

test('the instances table: every instance but the redundancy ones, with its mode', () => {
    const rows = L.instanceRows([
        { _id: 'system.adapter.redundancy.0', common: { host: 'iobStansiya486', enabled: true } },
        { _id: 'system.adapter.modbus.0', common: { host: 'iobStansiya486', enabled: true, redundancy: { mode: 'cold' } } },
        { _id: 'system.adapter.admin.0', common: { host: 'iobStansiya486', enabled: true } },
        { _id: 'system.adapter.rockwell-enip.0', common: { host: 'iobStansiya486_b', enabled: false, redundancy: { mode: 'warm' } } },
    ]);
    assert.deepStrictEqual(
        rows.map(r => [r.id, r.adapter, r.host, r.enabled, r.mode]),
        [
            ['admin.0', 'admin', 'iobStansiya486', true, 'none'],
            ['modbus.0', 'modbus', 'iobStansiya486', true, 'cold'],
            ['rockwell-enip.0', 'rockwell-enip', 'iobStansiya486_b', false, 'none'],
        ],
    );
});

test('a cold instance is ready to move only where its adapter is installed, ideally in its version', () => {
    const list = pair();
    const row = (id, host, version) => ({ id, adapter: id.split('.')[0], host, version, mode: 'cold' });
    assert.deepStrictEqual(L.readiness(row('modbus.0', 'iobStansiya486', '6.3.2'), list), []);
    assert.deepStrictEqual(L.readiness(row('mqtt.0', 'iobStansiya486', '7.0.0'), list), [{ level: 'bad', text: 'mqtt is not installed on B' }]);
    assert.deepStrictEqual(L.readiness(row('rockwell-enip.0', 'iobStansiya486', '0.2.1'), list), [{ level: 'warn', text: 'B has rockwell-enip 0.2.0, this instance 0.2.1' }]);
    assert.deepStrictEqual(L.readiness({ ...row('mqtt.0', 'iobStansiya486', '7.0.0'), mode: 'none' }, list), [], 'only cold instances move');
});

test('a server card says how its adapters differ from the other server', () => {
    const [a, b] = pair();
    assert.deepStrictEqual(L.adapterDiff(b, [a, b]), { missing: ['mqtt'], other: ['rockwell-enip 0.2.0 (A: 0.2.1)'] });
    assert.deepStrictEqual(L.adapterDiff(a, [a, b]), { missing: [], other: ['rockwell-enip 0.2.1 (B: 0.2.0)'] });
});

const cfgOf = (me, bind, peer, over = {}) => JSON.stringify({
    cluster: 'h0-vm',
    me,
    sentinelName: 'scada',
    sentinels: ['192.168.64.11:26379', '192.168.64.12:26379', '192.168.64.1:26379'],
    witness: '192.168.64.1:26379',
    witnessRequired: true,
    hosts: [
        { name: 'A', priority: 1, redis: '192.168.64.11:6379' },
        { name: 'B', priority: 2, redis: '192.168.64.12:6379' },
    ],
    links: [
        { name: 'nat', medium: 'lan', bind, peer, missed: null },
        { name: 'wifi', medium: 'wlan', bind: bind.replace('192.168.64', '172.20.0'), peer, missed: null },
    ],
    beatMs: 50,
    timing: { fenceAfterMs: 150, takeoverAfterMs: 250, leaseTtlMs: 5000 },
    redisHangMs: 3000,
    apiTokenSet: true,
    ...over,
});

function withConfigs(overB = {}) {
    return pair({
        'redundancy.0.watchdogConfig': st(cfgOf('A', '192.168.64.11:7001', '192.168.64.12:7001')),
        'redundancy.1.watchdogConfig': st(cfgOf('B', '192.168.64.12:7001', '192.168.64.11:7001', overB)),
        'redundancy.0.links': st('[{"name":"nat","lost":false},{"name":"wifi","lost":false}]'),
        'redundancy.1.links': st('[{"name":"nat","lost":false},{"name":"wifi","lost":true}]'),
    });
}

test('the settings view: servers of the config with their ioBroker host', () => {
    const v = L.settingsView(withConfigs());
    assert.deepStrictEqual(v.servers, [
        { priority: 1, name: 'A', iobHost: 'iobStansiya486', address: '192.168.64.11' },
        { priority: 2, name: 'B', iobHost: 'iobStansiya486_b', address: '192.168.64.12' },
    ]);
});

test('a value that differs between the hosts is flagged; the same value is shown once', () => {
    const same = L.settingsView(withConfigs());
    const fence = same.timing.find(r => r.key === 'fenceAfterMs');
    assert.deepStrictEqual(fence, { key: 'fenceAfterMs', label: 'Fence after (ms)', values: { A: 150, B: 150 }, same: true });
    const v = L.settingsView(withConfigs({ timing: { fenceAfterMs: 150, takeoverAfterMs: 400, leaseTtlMs: 5000 } }));
    const takeover = v.timing.find(r => r.key === 'takeoverAfterMs');
    assert.strictEqual(takeover.same, false);
    assert.deepStrictEqual(takeover.values, { A: 250, B: 400 });
    assert.strictEqual(v.cluster.find(r => r.key === 'witness').same, true);
});

test('links are paired by name, with each side, the medium default and each host now', () => {
    const v = L.settingsView(withConfigs());
    assert.deepStrictEqual(v.links[1], {
        name: 'wifi',
        medium: 'wlan',
        sides: { A: '172.20.0.11:7001', B: '172.20.0.12:7001' },
        lostAfter: 10,
        now: { A: 'ok', B: 'lost' },
    });
    assert.strictEqual(v.links[0].lostAfter, 3);
});

test('client options per host: ok, or what was found', () => {
    const v = L.settingsView(withConfigs());
    const keep = v.clientOptions.find(r => r.option === 'keepAlive');
    assert.deepStrictEqual(keep.values, { A: 'ok', B: 'missing in states' });
    assert.ok(v.clientOptions.find(r => r.option === 'retry_max_delay').values.B === 'ok');
});
