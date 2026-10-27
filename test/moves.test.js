'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { runMoves, reconcile, instanceFromObject, pairHosts } = require('../lib/moves');

const A = 'iobStansiya486';
const B = 'iobStansiya486_b';

/** An ioBroker stand-in that records every call; `aliveFor` polls the old copy stays alive. */
function fakeIo({ aliveFor = 0, instances = [], pair = [A, B], fail = [] } = {}) {
    const calls = [];
    let polls = 0;
    let clock = 0;
    const io = {
        calls,
        getInstances: async () => instances,
        getPair: async () => pair,
        getInstalled: async () => ({ modbus: '6.3.2' }),
        extend: async (id, common) => {
            if (fail.includes(id)) {
                throw new Error(`cannot write ${id}`);
            }
            calls.push(['extend', id, common]);
        },
        isAlive: async id => {
            calls.push(['isAlive', id]);
            return polls++ < aliveFor;
        },
        clearSigKill: async id => calls.push(['clearSigKill', id]),
        setNotAlive: async id => calls.push(['setNotAlive', id]),
        sleep: async ms => {
            clock += ms;
        },
        now: () => clock,
    };
    return io;
}

const writes = io => io.calls.filter(c => c[0] !== 'isAlive');

test('a gone old host: clear alive and sigKill, then move', async () => {
    const io = fakeIo();
    const r = await runMoves([{ id: 'modbus.0', from: A, stopFirst: false, enableAfter: false }], B, io);
    assert.deepStrictEqual(writes(io), [
        ['clearSigKill', 'modbus.0'],
        ['setNotAlive', 'modbus.0'],
        ['extend', 'modbus.0', { host: B, redundancy: { movingTo: null } }],
    ]);
    assert.deepStrictEqual(r, [{ id: 'modbus.0', from: A, ok: true, waitedMs: 0, timedOut: false }]);
});

test('a running old host: disable with movingTo, wait for the old copy, then move and enable', async () => {
    // the old host's stop writes sigKill = -1: it must happen before the new copy starts
    const io = fakeIo({ aliveFor: 3 });
    const r = await runMoves([{ id: 'modbus.0', from: A, stopFirst: true, enableAfter: true }], B, io, {
        waitMs: 10_000,
        minWaitMs: 0,
        pollMs: 250,
    });
    assert.deepStrictEqual(writes(io), [
        ['extend', 'modbus.0', { enabled: false, redundancy: { movingTo: B } }],
        ['clearSigKill', 'modbus.0'],
        ['setNotAlive', 'modbus.0'],
        ['extend', 'modbus.0', { host: B, enabled: true, redundancy: { movingTo: null } }],
    ]);
    assert.strictEqual(r[0].waitedMs, 750);
    assert.strictEqual(r[0].timedOut, false);
});

test('the old host gets time to stop even when alive is already false', async () => {
    // VM run 2026-10-26: alive was false (the copy was restarting), the move ran 1 ms after
    // the disable, and the old host wrote its sigKill after our clear
    const io = fakeIo({ aliveFor: 0 });
    const r = await runMoves([{ id: 'modbus.0', from: A, stopFirst: true, enableAfter: true }], B, io, {
        waitMs: 10_000,
        minWaitMs: 3000,
        pollMs: 250,
    });
    assert.strictEqual(r[0].waitedMs, 3000);
    const clear = io.calls.findIndex(c => c[0] === 'clearSigKill');
    assert.ok(io.calls.slice(0, clear).filter(c => c[0] === 'isAlive').length >= 1);
});

test('an old copy that does not stop in time is moved anyway, and says so', async () => {
    // its host does not answer the stop (cut off from the database): staying off is an outage
    const io = fakeIo({ aliveFor: 1000 });
    const r = await runMoves([{ id: 'modbus.0', from: A, stopFirst: true, enableAfter: true }], B, io, {
        waitMs: 1000,
        pollMs: 250,
    });
    assert.strictEqual(r[0].ok, true);
    assert.strictEqual(r[0].timedOut, true);
    assert.deepStrictEqual(writes(io).at(-1), [
        'extend',
        'modbus.0',
        { host: B, enabled: true, redundancy: { movingTo: null } },
    ]);
});

test('one failed move does not stop the others', async () => {
    const io = fakeIo({ fail: ['modbus.0'] });
    const r = await runMoves(
        [
            { id: 'modbus.0', from: A, stopFirst: false, enableAfter: false },
            { id: 'opcua.0', from: A, stopFirst: false, enableAfter: false },
        ],
        B,
        io,
    );
    assert.deepStrictEqual(
        r.map(x => [x.id, x.ok]),
        [
            ['modbus.0', false],
            ['opcua.0', true],
        ],
    );
    assert.match(r[0].error, /cannot write modbus.0/);
});

test('reconcile moves only on the primary, with the watchdog telling whether the old host is gone', async () => {
    const instances = [{ id: 'modbus.0', host: A, enabled: true, mode: 'cold' }];
    const seen = [];
    const addon = {
        planMoves: json => {
            seen.push(JSON.parse(json));
            return JSON.stringify({
                moves: [{ id: 'modbus.0', from: A, stopFirst: false, enableAfter: false }],
                skipped: [{ id: 'rockwell-enip.0', reason: 'rockwell-enip is not installed' }],
            });
        },
    };
    const standby = await reconcile({ status: { role: 'standby', peer: 'Ok' }, me: B, addon, io: fakeIo({ instances }) });
    assert.deepStrictEqual(standby, { moves: [], skipped: [] }, 'a standby moves nothing');
    const fenced = await reconcile({ status: { role: 'fenced', peer: 'Lost' }, me: B, addon, io: fakeIo({ instances }) });
    assert.deepStrictEqual(fenced, { moves: [], skipped: [] });
    assert.strictEqual(seen.length, 0, 'not even planned');

    const io = fakeIo({ instances });
    const r = await reconcile({ status: { role: 'primary', peer: 'Lost' }, me: B, addon, io });
    assert.deepStrictEqual(seen[0], { me: B, pair: [A, B], oldHostGone: true, instances, installed: { modbus: '6.3.2' } });
    assert.strictEqual(r.moves[0].ok, true);
    assert.deepStrictEqual(r.skipped, [{ id: 'rockwell-enip.0', reason: 'rockwell-enip is not installed' }]);
    await reconcile({ status: { role: 'primary', peer: 'Ok' }, me: B, addon, io });
    assert.strictEqual(seen[1].oldHostGone, false);
});

test('an instance object becomes what planMoves reads; an unknown mode counts as none', () => {
    const obj = (common) => ({ _id: 'system.adapter.modbus.0', common: { host: A, enabled: true, ...common } });
    assert.deepStrictEqual(instanceFromObject(obj({ redundancy: { mode: 'cold' }, version: '6.3.2' })), {
        id: 'modbus.0',
        host: A,
        enabled: true,
        mode: 'cold',
        movingTo: null,
        version: '6.3.2',
    });
    assert.strictEqual(instanceFromObject(obj({})).version, null);
    // one bad value must not stop the plan for every instance
    assert.strictEqual(instanceFromObject(obj({ redundancy: { mode: 'warm' } })).mode, 'none');
    assert.strictEqual(instanceFromObject(obj({})).mode, 'none');
    assert.strictEqual(instanceFromObject(obj({ redundancy: { mode: 'cold', movingTo: B } })).movingTo, B);
    assert.strictEqual(instanceFromObject(obj({ enabled: undefined })).enabled, false);
    assert.strictEqual(instanceFromObject({ _id: 'system.adapter.x.0', common: {} }), null, 'no host');
});

test('the pair is every host that runs a redundancy instance', () => {
    const rows = [
        { _id: 'system.adapter.redundancy.0', common: { host: A } },
        { _id: 'system.adapter.redundancy.1', common: { host: B } },
        { _id: 'system.adapter.redundancy.2', common: { host: B } },
        { _id: 'system.adapter.modbus.0', common: { host: 'slave-c' } },
    ];
    assert.deepStrictEqual(pairHosts(rows), [A, B]);
});
