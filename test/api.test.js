'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { WatchdogClient, defaultApiPath, request, pushEvent } = require('../lib/api');

let n = 0;
function endpoint() {
    const name = `scada-api-test-${process.pid}-${Date.now()}-${n++}`;
    return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

/** A stand-in watchdog: records what clients send, `onLine(socket, line)` answers. */
function fakeWatchdog(where, onLine) {
    const got = [];
    const server = net.createServer(s => {
        let buf = '';
        s.on('data', d => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                got.push(line);
                onLine(s, line);
            }
        });
        s.on('error', () => {});
    });
    return new Promise(resolve => server.listen(where, () => resolve({ server, got })));
}

const once = (em, ev) => new Promise(resolve => em.once(ev, resolve));

test('the client subscribes and passes status and events on', async () => {
    const where = endpoint();
    const { server, got } = await fakeWatchdog(where, s => {
        s.write('{"type":"status","role":"primary","epoch":37}\n{"type":"event","event":"role","role":"fenced"}\n');
    });
    const c = new WatchdogClient(where);
    const status = once(c, 'status');
    const event = once(c, 'event');
    c.start();
    assert.deepStrictEqual(await status, { type: 'status', role: 'primary', epoch: 37 });
    assert.strictEqual((await event).role, 'fenced');
    assert.deepStrictEqual(got, ['{"op":"subscribe"}']);
    c.stop();
    server.close();
});

test('bad lines are skipped, a line split over two packets is joined', async () => {
    const where = endpoint();
    const { server } = await fakeWatchdog(where, s => {
        s.write('not json\n{"type":"stat');
        setTimeout(() => s.write('us","role":"standby"}\n'), 20);
    });
    const c = new WatchdogClient(where);
    const status = once(c, 'status');
    c.start();
    assert.strictEqual((await status).role, 'standby');
    c.stop();
    server.close();
});

test('a lost connection is opened again and subscribes again', async () => {
    const where = endpoint();
    let conns = 0;
    const { server, got } = await fakeWatchdog(where, s => {
        conns++;
        s.write('{"type":"status","role":"primary"}\n');
        if (conns === 1) {
            setTimeout(() => s.destroy(), 10);
        }
    });
    const c = new WatchdogClient(where, { reconnectMs: 30 });
    let ups = 0;
    const twice = new Promise(resolve =>
        c.on('status', () => {
            if (++ups === 2) {
                resolve();
            }
        }),
    );
    c.start();
    await twice;
    assert.deepStrictEqual(got, ['{"op":"subscribe"}', '{"op":"subscribe"}']);
    c.stop();
    server.close();
});

test('no watchdog listening: the client keeps trying and says it is down', async () => {
    const c = new WatchdogClient(endpoint(), { reconnectMs: 20 });
    const down = once(c, 'down');
    c.start();
    await down;
    c.stop();
});

test('the API sits next to the status file, or is the named pipe on Windows', () => {
    assert.strictEqual(defaultApiPath('/var/lib/scada/watchdog-status.json', 'linux'), '/var/lib/scada/watchdog.sock');
    assert.strictEqual(defaultApiPath('/var/lib/scada/watchdog-status.json', 'darwin'), '/var/lib/scada/watchdog.sock');
    assert.strictEqual(defaultApiPath('', 'linux'), null);
    assert.strictEqual(defaultApiPath('C:\\ProgramData\\SCADA\\s.json', 'win32'), '\\\\.\\pipe\\scada-redundancy-watchdog');
});

test('a request gets the one answer line back', async () => {
    const where = endpoint();
    const { server, got } = await fakeWatchdog(where, (s, l) => {
        const r = JSON.parse(l);
        s.write(`${JSON.stringify({ type: r.op, to: r.to, by: r.by })}\n`);
    });
    const reply = await request(where, { op: 'switchover', to: 'B', by: 'admin', token: 't' });
    assert.deepStrictEqual(reply, { type: 'switchover', to: 'B', by: 'admin' });
    assert.deepStrictEqual(JSON.parse(got[0]).token, 't');
    server.close();
});

test('a request with no watchdog, or no answer in time, fails with a reason', async () => {
    await assert.rejects(request(endpoint(), { op: 'status' }, 500), /watchdog API/);
    const where = endpoint();
    const { server } = await fakeWatchdog(where, () => {});
    await assert.rejects(request(where, { op: 'switchover', to: 'B' }, 200), /no answer/);
    server.close();
});

test('the event list keeps the newest ones first and at most max', () => {
    let list = [];
    for (let i = 1; i <= 5; i++) {
        list = pushEvent(list, { event: 'role', t: i }, 3);
    }
    assert.deepStrictEqual(
        list.map(e => e.t),
        [5, 4, 3],
    );
    assert.strictEqual(pushEvent([], { type: 'event', event: 'x', t: 1 }, 3)[0].type, undefined, 'the line type is dropped');
});
