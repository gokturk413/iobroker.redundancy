'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { InstanceCache, FULL_EVERY_MS } = require('../lib/instances');

const inst = (id, host = 'A') => ({ _id: `system.adapter.${id}`, type: 'instance', common: { host } });

function setup(list) {
    let clock = 1000;
    let reads = 0;
    const cache = new InstanceCache(
        async () => {
            reads++;
            return list();
        },
        () => clock,
    );
    return { cache, reads: () => reads, tick: ms => (clock += ms) };
}

test('read once, then served from memory', async () => {
    const s = setup(() => [inst('modbus.0'), inst('web.0')]);
    assert.strictEqual((await s.cache.list()).length, 2);
    await s.cache.list();
    await s.cache.list();
    assert.strictEqual(s.reads(), 1);
});

test('object changes keep it current without a read', async () => {
    const s = setup(() => [inst('modbus.0')]);
    await s.cache.list();
    s.cache.apply('system.adapter.modbus.0', inst('modbus.0', 'B'));
    s.cache.apply('system.adapter.web.0', inst('web.0'));
    s.cache.apply('system.adapter.modbus.0.alive', { type: 'state' });
    s.cache.apply('system.adapter.web.0', null);
    const l = await s.cache.list();
    assert.deepStrictEqual(l.map(o => [o._id, o.common.host]), [['system.adapter.modbus.0', 'B']]);
    assert.strictEqual(s.reads(), 1);
});

test('a full read again after a while, and on request', async () => {
    const s = setup(() => [inst('modbus.0')]);
    await s.cache.list();
    s.tick(FULL_EVERY_MS - 1);
    await s.cache.list();
    assert.strictEqual(s.reads(), 1);
    s.tick(1);
    await s.cache.list();
    assert.strictEqual(s.reads(), 2);
    await s.cache.refresh();
    assert.strictEqual(s.reads(), 3);
});

test('callers during a read share it; only instance objects are kept', async () => {
    const s = setup(() => [inst('modbus.0'), { _id: 'system.adapter.modbus.0.alive', type: 'state' }, null]);
    await Promise.all([s.cache.refresh(), s.cache.refresh(), s.cache.list()]);
    assert.strictEqual(s.reads(), 1);
    assert.strictEqual((await s.cache.list()).length, 1);
});

test('a failed read is reported and the next call tries again', async () => {
    let fail = true;
    const s = setup(() => {
        if (fail) {
            throw new Error('Connection is closed');
        }
        return [inst('modbus.0')];
    });
    await assert.rejects(s.cache.list(), /Connection is closed/);
    fail = false;
    assert.strictEqual((await s.cache.list()).length, 1);
});
