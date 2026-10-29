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

test('a line only one server may drive is found in the instance settings', () => {
    const r = native => L.exclusiveResource(native);
    assert.deepStrictEqual(r({ params: { type: 'serial', comName: '/dev/ttyS0', bind: '0.0.0.0', port: 502 } }), { kind: 'serial', text: 'serial line /dev/ttyS0' });
    assert.deepStrictEqual(r({ params: { type: 'tcprtu', bind: '192.168.1.30', port: 4001 } }), { kind: 'single-client', text: 'RTU over TCP 192.168.1.30:4001' });
    assert.strictEqual(r({ params: { type: 'tcp', bind: '192.168.1.30', port: 502, comName: '/dev/ttyUSB0' } }), null, 'TCP chosen: the port left in the settings is not used');
    assert.strictEqual(r({ params: { type: 'tcp-ssl', bind: '192.168.1.30', port: 802 } }), null);
    // any adapter: a serial device path, or a mode that says RTU over TCP
    assert.deepStrictEqual(r({ device: { path: 'COM3' } }), { kind: 'serial', text: 'serial line COM3' });
    assert.deepStrictEqual(r({ usbPath: '/dev/serial/by-id/usb-FTDI-if00' }), { kind: 'serial', text: 'serial line /dev/serial/by-id/usb-FTDI-if00' });
    assert.deepStrictEqual(r({ protocol: 'RTU over TCP', host: '10.0.0.5', port: 502 }), { kind: 'single-client', text: 'RTU over TCP 10.0.0.5:502' });
    assert.strictEqual(r({ ip: '192.168.1.1', note: 'see COM3 in the manual' }), null, 'a path inside a text is not a setting');
    assert.strictEqual(r(undefined), null);
});

test('choosing hot says what can go wrong; an exclusive line is a reason to stay cold', () => {
    const rows = L.instanceRows([
        { _id: 'system.adapter.modbus.0', common: { host: 'A', redundancy: { mode: 'cold' } }, native: { params: { type: 'serial', comName: '/dev/ttyS0' } } },
        { _id: 'system.adapter.modbus.1', common: { host: 'A' }, native: { params: { type: 'tcprtu', bind: '192.168.1.30', port: 4001 } } },
        { _id: 'system.adapter.rockwell-enip.0', common: { host: 'A', redundancy: { hot: true } }, native: { ip: '192.168.1.1' } },
        { _id: 'system.adapter.opcua.0', common: { host: 'A' }, native: { endpoint: 'opc.tcp://localhost:4840' } },
    ]);
    const by = id => rows.find(x => x.id === id);
    assert.deepStrictEqual(by('modbus.0').resource, { kind: 'serial', text: 'serial line /dev/ttyS0' });
    assert.strictEqual(by('rockwell-enip.0').hotDeclared, true);
    assert.strictEqual(by('opcua.0').hotDeclared, false);

    const levels = id => L.hotCheck(by(id)).map(w => w.level);
    assert.deepStrictEqual(levels('modbus.0'), ['bad', 'warn']);
    assert.match(L.hotCheck(by('modbus.0'))[0].text, /serial line \/dev\/ttyS0.*one master/);
    assert.match(L.hotCheck(by('modbus.1'))[0].text, /RTU over TCP 192\.168\.1\.30:4001.*one client/);
    assert.deepStrictEqual(levels('rockwell-enip.0'), [], 'declares hot, no exclusive line');
    assert.deepStrictEqual(levels('opcua.0'), ['warn']);
    assert.match(L.hotCheck(by('opcua.0'))[0].text, /does not declare hot support/);
});

test('a cold instance is ready to move only where its adapter is installed, ideally in its version', () => {
    const list = pair();
    const row = (id, host, version) => ({ id, adapter: id.split('.')[0], host, version, mode: 'cold' });
    assert.deepStrictEqual(L.readiness(row('modbus.0', 'iobStansiya486', '6.3.2'), list), []);
    assert.deepStrictEqual(L.readiness(row('mqtt.0', 'iobStansiya486', '7.0.0'), list), [{ level: 'bad', text: 'mqtt is not installed on B' }]);
    assert.deepStrictEqual(L.readiness(row('rockwell-enip.0', 'iobStansiya486', '0.2.1'), list), [{ level: 'warn', text: 'B has rockwell-enip 0.2.0, this instance 0.2.1' }]);
    assert.deepStrictEqual(L.readiness({ ...row('mqtt.0', 'iobStansiya486', '7.0.0'), mode: 'none' }, list), [], 'only cold instances move');
    assert.strictEqual(L.readiness({ ...row('mqtt.0', 'iobStansiya486', '7.0.0'), mode: 'hot' }, list).length, 1, 'hot moves like cold until H3');
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
        missed: { A: null, B: null },
        now: { A: 'ok', B: 'lost' },
    });
    assert.strictEqual(v.links[0].lostAfter, 3);
});

test('the settings form starts from the servers values; only what changed is sent', () => {
    const v = L.settingsView(withConfigs());
    const form = L.settingsForm(v);
    assert.deepStrictEqual(form, {
        fenceAfterMs: 150, takeoverAfterMs: 250, leaseTtlMs: 5000, beatMs: 50, redisHangMs: 3000,
        witnessRequired: true, missed: { nat: null, wifi: null },
    });
    assert.deepStrictEqual(L.settingsPatch(v, form), { patch: {}, errors: [] });
    assert.deepStrictEqual(L.settingsPatch(v, { ...form, takeoverAfterMs: 400, missed: { nat: 5, wifi: null } }), {
        patch: { timing: { takeoverAfterMs: 400 }, links: [{ name: 'nat', missed: 5 }] },
        errors: [],
    });
    assert.deepStrictEqual(L.settingsPatch(v, { ...form, witnessRequired: false, beatMs: 40 }).patch, { beatMs: 40, witnessRequired: false });
});

test('settings that cannot work are refused in the tab already', () => {
    const v = L.settingsView(withConfigs());
    const form = L.settingsForm(v);
    const err = f => L.settingsPatch(v, { ...form, ...f }).errors.join(' ');
    assert.match(err({ takeoverAfterMs: 180 }), /take over/i);
    assert.match(err({ beatMs: 5 }), /heartbeat/i);
    assert.match(err({ redisHangMs: 0 }), /busy Redis/i);
    assert.match(err({ fenceAfterMs: 1.5 }), /whole number/i);
    assert.match(err({ missed: { nat: 0, wifi: null } }), /nat/);
    assert.strictEqual(L.settingsPatch(v, { ...form, takeoverAfterMs: 180 }).patch.timing, undefined, 'nothing is sent with an error');
});

test('a value the servers disagree on is sent, so that they agree again', () => {
    const v = L.settingsView(withConfigs({ timing: { fenceAfterMs: 150, takeoverAfterMs: 400, leaseTtlMs: 5000 } }));
    const form = L.settingsForm(v);
    assert.strictEqual(form.takeoverAfterMs, 250, 'the first server');
    assert.deepStrictEqual(L.settingsPatch(v, form).patch, { timing: { takeoverAfterMs: 250 } });
});

test('client options per host: ok, or what was found', () => {
    const v = L.settingsView(withConfigs());
    const keep = v.clientOptions.find(r => r.option === 'keepAlive');
    assert.deepStrictEqual(keep.values, { A: 'ok', B: 'missing in states' });
    assert.ok(v.clientOptions.find(r => r.option === 'retry_max_delay').values.B === 'ok');
});

test('sync: what the target server installs to match the source', () => {
    const [a, b] = pair();
    assert.deepStrictEqual(L.syncPlan(a, b), {
        steps: [
            { adapter: 'mqtt', have: '', want: '7.0.0', cmd: 'iobroker install mqtt@7.0.0' },
            { adapter: 'rockwell-enip', have: '0.2.0', want: '0.2.1', cmd: 'iobroker upgrade rockwell-enip@0.2.1 -y' },
        ],
        extra: [],
        refused: [],
    });
    assert.deepStrictEqual(L.syncPlan(b, a).extra, ['mqtt'], 'only on the target: left alone, named');
});

test('sync: a name or version that is not plain is never put into a command', () => {
    const src = { name: 'A', installed: { 'good-one': '1.2.3', 'x;rm -rf /': '1.0.0', web: '1.0.0 && reboot', hm: '2.0.0-beta.1' } };
    const dst = { name: 'B', installed: {} };
    const p = L.syncPlan(src, dst);
    assert.deepStrictEqual(p.steps.map(s => s.cmd), ['iobroker install good-one@1.2.3', 'iobroker install hm@2.0.0-beta.1']);
    assert.deepStrictEqual(p.refused.sort(), ['web', 'x;rm -rf /']);
});

test('licence: each server says its state and what to do', () => {
    const info = (state, extra = {}) => st(JSON.stringify({ state, valid: state === 'valid', stops: state === 'trial-expired', message: `m-${state}`, hardwareIds: ['hw3-x'], ...extra }));
    const list = pair({ 'redundancy.0.license.info': info('valid', { licenseId: 'R-1', owner: 'Plant Ltd', maxServers: 2 }), 'redundancy.1.license.info': info('trial', { daysLeft: 9 }) });
    const v = L.licenceView(list);
    assert.deepStrictEqual(v.rows.map(r => [r.name, r.state, r.message]), [['A', 'valid', 'm-valid'], ['B', 'trial', 'm-trial']]);
    assert.strictEqual(v.allValid, false);
    assert.strictEqual(v.licenseId, 'R-1');
    assert.strictEqual(L.licenceView(pair()).rows[0].state, '', 'not reported yet');
});

test('the activation request of the pair is one file with every server request', () => {
    const r = n => JSON.stringify({ format: 'scada-activation-request/1', product: 'scada-redundancy', hostName: n, hardwareIds: [`hw3-${n}`], check: 'c' });
    const b = L.activationBundle('h0-vm', [{ server: 'A', request: r('A') }, { server: 'B', request: r('B') }], 1000);
    assert.strictEqual(b.format, 'scada-activation-bundle/1');
    assert.strictEqual(b.product, 'scada-redundancy');
    assert.strictEqual(b.cluster, 'h0-vm');
    assert.deepStrictEqual(b.requests.map(x => x.hostName), ['A', 'B']);
    assert.throws(() => L.activationBundle('h0-vm', [{ server: 'A', request: 'not json' }], 1), /A/);
    assert.throws(() => L.activationBundle('h0-vm', [], 1), /no server/);
});

// ── instance health (RFC-003 §2.11) ──────────────────────────────────────────
test('health form: the RFC defaults and a probe target from the instance settings', () => {
    const f = L.healthForm({ mode: 'cold', critical: true }, { ip: '192.168.1.1' }, 'rockwell-enip');
    assert.strictEqual(f.onFailure, 'host');
    assert.strictEqual(L.signalText(f), 'info.connection = false · 3× · 10 s');
    assert.strictEqual(f.target, '192.168.1.1:44818');
    assert.strictEqual(L.healthForm({ mode: 'cold' }, {}, 'x').onFailure, 'none');
    assert.strictEqual(L.suggestTarget({ params: { type: 'tcp', bind: '10.0.0.5', port: 502 } }, 'modbus'), '10.0.0.5:502');
    assert.strictEqual(L.suggestTarget({ endpoint: 'opc.tcp://plc:4841/ua' }, 'opcua'), 'plc:4841');
    assert.strictEqual(L.suggestTarget({ bind: '0.0.0.0' }, 'modbus'), '', 'a listen address is no device');
    const saved = L.healthForm({ critical: true, verify: { kind: 'none', target: 'a:1' }, health: { badWhen: '>= 5', detectMs: 20000 } }, { ip: 'x' }, 'modbus');
    assert.strictEqual(saved.verify, 'none');
    assert.strictEqual(saved.target, 'a:1', 'a saved target wins over the suggestion');
    assert.strictEqual(L.signalText(saved), 'info.connection >= 5 · 3× · 20 s');
});

test('health patch: checked before it is saved', () => {
    const f = L.healthForm({ critical: true }, { ip: '192.168.1.1' }, 'rockwell-enip');
    assert.deepStrictEqual(L.healthPatch(f).patch, {
        critical: true,
        onFailure: 'host',
        health: { state: 'info.connection', badWhen: 'false', failures: 3, detectMs: 10000, recoverMs: 30000 },
        verify: { kind: 'probe', target: '192.168.1.1:44818' },
    });
    for (const [k, v] of [['state', 'a b'], ['badWhen', 'val === false'], ['failures', 0], ['detectS', 0.5], ['recoverS', -1], ['target', '192.168.1.1']]) {
        assert.ok(L.healthPatch({ ...f, [k]: v }).error, `${k} = ${v}`);
    }
    assert.ok(L.healthPatch({ ...f, target: '', verify: 'none' }).patch, 'no target needed without a probe');
    assert.ok(L.healthPatch({ ...f, target: '', critical: false }).patch, 'nor for an instance that is not critical');
});

test('health now: each server\'s report of one instance', () => {
    const list = [
        { name: 'A', health: { t: NOW, instances: { 'rockwell-enip.0': { state: 'failed', reach: null } }, failing: ['rockwell-enip.0'], problems: [] } },
        { name: 'B', health: { t: NOW, instances: { 'rockwell-enip.0': { state: null, reach: true } } } },
    ];
    assert.deepStrictEqual(L.healthNow('rockwell-enip.0', list, NOW), {
        level: 'bad',
        text: 'failed on A · moves the primary from A · B reaches the device',
    });
    const field = [
        { name: 'A', health: { t: NOW, instances: { 'm.0': { state: 'failed' } }, problems: [{ id: 'm.0', why: 'field problem: the device is unreachable from every server' }] } },
        { name: 'B', health: { t: NOW - 60000, instances: { 'm.0': { reach: true } } } },
    ];
    assert.match(L.healthNow('m.0', field, NOW).text, /^failed on A · field problem/);
    assert.deepStrictEqual(L.healthNow('m.0', field, NOW + 20000), { level: 'dim', text: 'no report yet' });
    assert.deepStrictEqual(L.healthNow('x.0', [{ name: 'A', health: { t: NOW, instances: { 'x.0': { state: 'ok' } } } }], NOW), { level: 'good', text: 'ok on A' });
});

test('events: an instance failing or recovering, and the health the watchdog got', () => {
    assert.deepStrictEqual(L.describeEvent({ event: 'instance', id: 'modbus.0', state: 'failed', critical: true, host: 'A' }), {
        level: 'bad',
        title: 'modbus.0 failed on A',
        detail: 'critical',
    });
    assert.strictEqual(L.describeEvent({ event: 'instance', id: 'modbus.0', state: 'ok' }).level, 'info');
    assert.strictEqual(L.describeEvent({ event: 'health', score: 50, failed: 2, failing: ['a.0', 'b.0'] }).title, 'Critical instances failing: a.0, b.0');
});
