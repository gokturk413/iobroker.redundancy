'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { parseBadWhen, parseTarget, healthConfig, Tracker, summarize, DEFAULTS } = require('../lib/health');

test('badWhen: false, true and number comparisons only, never code', () => {
    assert.strictEqual(parseBadWhen('false')(false), true);
    assert.strictEqual(parseBadWhen('false')(true), false);
    assert.strictEqual(parseBadWhen('false')(null), false, 'no value yet is not bad');
    assert.strictEqual(parseBadWhen('true')(true), true);
    assert.strictEqual(parseBadWhen('>= 5')(5), true);
    assert.strictEqual(parseBadWhen('>= 5')(4), false);
    assert.strictEqual(parseBadWhen('>=5')('7'), true);
    assert.strictEqual(parseBadWhen('< 1')(''), false);
    assert.strictEqual(parseBadWhen('!= 0')(2), true);
    for (const bad of ['val === false', 'process.exit()', '>= x', '', '=> 1']) {
        assert.strictEqual(parseBadWhen(bad), null, bad);
    }
});

test('probe target: host:port only', () => {
    assert.deepStrictEqual(parseTarget('192.168.1.1:44818'), { host: '192.168.1.1', port: 44818 });
    assert.deepStrictEqual(parseTarget('plc-1.local:502'), { host: 'plc-1.local', port: 502 });
    assert.deepStrictEqual(parseTarget('[fe80::1]:502'), { host: 'fe80::1', port: 502 });
    for (const bad of ['192.168.1.1', ':502', 'a:0', 'a:70000', 'a b:1', '']) {
        assert.strictEqual(parseTarget(bad), null, bad);
    }
});

test('config: the RFC defaults; a critical instance moves the whole primary', () => {
    const c = healthConfig({ mode: 'cold', critical: true });
    assert.strictEqual(c.onFailure, 'host');
    assert.deepStrictEqual(c.health, DEFAULTS);
    assert.deepStrictEqual(c.verify, { kind: 'probe', target: '' });
    assert.strictEqual(healthConfig({ mode: 'cold' }).onFailure, 'none');
    const odd = healthConfig({
        critical: 'yes',
        onFailure: 'instance',
        health: { state: 'a;b', badWhen: 'x', failures: 0, detectMs: 5 },
        verify: { kind: 'shadow', target: 'nope' },
    });
    assert.strictEqual(odd.critical, false);
    assert.strictEqual(odd.onFailure, 'none', 'the L2 split is not offered');
    assert.deepStrictEqual(odd.health, DEFAULTS);
    assert.deepStrictEqual(odd.verify, { kind: 'probe', target: '' });
});

const cfg = (over = {}) => healthConfig({ critical: true, verify: { kind: 'probe', target: '10.0.0.5:502' }, ...over });

test('tracker: failed after 3 bad readings or 10 s of bad', () => {
    const t = new Tracker(cfg().health);
    assert.strictEqual(t.feed(true, true, 0), 'ok');
    assert.strictEqual(t.feed(false, true, 1000), 'suspect');
    assert.strictEqual(t.feed(false, true, 2000), 'suspect');
    assert.strictEqual(t.feed(false, true, 3000), 'failed');
    const slow = new Tracker(cfg().health);
    slow.feed(false, true, 0);
    assert.strictEqual(slow.tick(9999), 'suspect');
    assert.strictEqual(slow.tick(10_000), 'failed', 'one bad value that lasts');
});

test('tracker: a short blip is forgotten; a failed one needs 30 s of good to recover', () => {
    const t = new Tracker(cfg().health);
    t.feed(false, true, 0);
    assert.strictEqual(t.feed(true, true, 500), 'ok');
    t.feed(false, true, 1000);
    t.tick(11_000);
    assert.strictEqual(t.state, 'failed');
    assert.strictEqual(t.feed(true, true, 12_000), 'failed');
    assert.strictEqual(t.tick(41_999), 'failed');
    t.feed(false, true, 20_000);
    t.feed(true, true, 21_000);
    assert.strictEqual(t.tick(50_999), 'failed', 'the flap restarted the recovery time');
    assert.strictEqual(t.tick(51_000), 'ok');
});

test('tracker: an instance that is not alive is bad whatever its signal says', () => {
    const t = new Tracker(cfg().health);
    t.feed(true, false, 0);
    assert.strictEqual(t.tick(10_000), 'failed');
});

const peer = (now, instances) => ({ t: now, host: 'B', instances });

test('summary: a failing critical instance moves the primary only if the standby reaches its device', () => {
    const rows = [
        { id: 'rockwell-enip.0', cfg: cfg(), state: 'failed' },
        { id: 'prosoft_flow.0', cfg: cfg(), state: 'ok' },
    ];
    const ok = summarize({ rows, primary: true, peers: [peer(1000, { 'rockwell-enip.0': { reach: true } })], now: 1000 });
    assert.deepStrictEqual(ok.failing, ['rockwell-enip.0']);
    assert.strictEqual(ok.score, 50);
    const field = summarize({ rows, primary: true, peers: [peer(1000, { 'rockwell-enip.0': { reach: false } })], now: 1000 });
    assert.deepStrictEqual(field.failing, []);
    assert.match(field.problems[0].why, /field problem/);
    const stale = summarize({ rows, primary: true, peers: [peer(0, { 'rockwell-enip.0': { reach: true } })], now: 20_000 });
    assert.deepStrictEqual(stale.failing, [], 'an old report of B proves nothing');
    assert.match(stale.problems[0].why, /not checked/);
});

test('summary: verify none moves without a check; alarm only and no target never move', () => {
    const rows = [
        { id: 'a.0', cfg: cfg({ verify: { kind: 'none' } }), state: 'failed' },
        { id: 'b.0', cfg: cfg({ onFailure: 'none' }), state: 'failed' },
        { id: 'c.0', cfg: cfg({ verify: { kind: 'probe' } }), state: 'failed' },
        { id: 'd.0', cfg: healthConfig({}), state: 'failed' },
    ];
    const s = summarize({ rows, primary: true, peers: [], now: 0 });
    assert.deepStrictEqual(s.failing, ['a.0']);
    assert.deepStrictEqual(s.problems.map(p => p.id), ['b.0', 'c.0']);
    assert.strictEqual(s.score, 0, 'd.0 is not critical: not in the score');
});

test('summary: a standby scores what it can reach and moves nothing', () => {
    const rows = [
        { id: 'a.0', cfg: cfg(), reach: true },
        { id: 'b.0', cfg: cfg(), reach: false },
        { id: 'c.0', cfg: cfg(), state: 'failed', reach: null },
    ];
    const s = summarize({ rows, primary: false, peers: [], now: 0 });
    assert.strictEqual(s.score, 33);
    assert.deepStrictEqual(s.failing, []);
    assert.deepStrictEqual(s.instances['b.0'], { state: null, reach: false });
    assert.strictEqual(summarize({ rows: [], primary: true, peers: [], now: 0 }).score, 100);
});

test('probe: an open port answers, a closed one does not', async () => {
    const net = require('node:net');
    const { tcpProbe } = require('../lib/probe');
    const server = net.createServer(s => s.destroy());
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    assert.strictEqual(await tcpProbe({ host: '127.0.0.1', port }), true);
    await new Promise(r => server.close(r));
    assert.strictEqual(await tcpProbe({ host: '127.0.0.1', port }, 1000), false);
});
