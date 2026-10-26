'use strict';
// The watchdog's local API (a Unix socket, or a named pipe on Windows), one JSON object per
// line: the client subscribes and gets the status every 500 ms and every event as it happens.

const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const RECONNECT_MS = 2000;
/** A line longer than this is not from the watchdog: drop the connection. */
const MAX_BUFFER = 1 << 20;

/** Emits `status` and `event` (the parsed lines), `up` and `down`. */
class WatchdogClient extends EventEmitter {
    /**
     * @param {string} where socket path or pipe path
     * @param {{reconnectMs?: number}} [opts]
     */
    constructor(where, opts = {}) {
        super();
        this.where = where;
        this.reconnectMs = opts.reconnectMs ?? RECONNECT_MS;
        this.socket = null;
        this.timer = null;
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.timer = null;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    connect() {
        let buf = '';
        const s = net.connect(this.where);
        this.socket = s;
        s.setEncoding('utf8');
        s.on('connect', () => {
            s.write('{"op":"subscribe"}\n');
            this.emit('up');
        });
        s.on('data', chunk => {
            buf += chunk;
            if (buf.length > MAX_BUFFER) {
                s.destroy();
                return;
            }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (msg && (msg.type === 'status' || msg.type === 'event')) {
                    this.emit(msg.type, msg);
                }
            }
        });
        s.on('error', () => {
            // 'close' follows
        });
        s.on('close', () => {
            if (this.socket === s) {
                this.socket = null;
            }
            this.emit('down');
            if (!this.stopped) {
                this.timer = setTimeout(() => this.connect(), this.reconnectMs);
            }
        });
    }
}

/**
 * @param {string} statusFile the watchdog's status file (its folder holds the socket)
 * @param {string} platform process.platform
 */
function defaultApiPath(statusFile, platform) {
    if (platform === 'win32') {
        return '\\\\.\\pipe\\scada-redundancy-watchdog';
    }
    return statusFile ? path.posix.join(path.posix.dirname(statusFile), 'watchdog.sock') : null;
}

/** A switchover answers when it is done: Sentinel's promotion takes a few seconds. */
const REQUEST_MS = 30_000;

/**
 * One request, one answer line (`{type: op | "error", ...}`).
 *
 * @param {string} where socket path or pipe path
 * @param {object} req e.g. {op: "switchover", to: "B", by, reason, token}
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
function request(where, req, timeoutMs = REQUEST_MS) {
    return new Promise((resolve, reject) => {
        let buf = '';
        let done = false;
        const s = net.connect(where);
        const finish = (err, msg) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            s.destroy();
            if (err) {
                reject(err);
            } else {
                resolve(msg);
            }
        };
        const timer = setTimeout(() => finish(new Error(`no answer from the watchdog in ${timeoutMs} ms`)), timeoutMs);
        s.setEncoding('utf8');
        s.on('connect', () => s.write(`${JSON.stringify(req)}\n`));
        s.on('data', chunk => {
            buf += chunk;
            const i = buf.indexOf('\n');
            if (i >= 0) {
                try {
                    finish(null, JSON.parse(buf.slice(0, i)));
                } catch (e) {
                    finish(new Error(`bad answer from the watchdog: ${e.message}`));
                }
            } else if (buf.length > MAX_BUFFER) {
                finish(new Error('answer too long'));
            }
        });
        s.on('error', e => finish(new Error(`watchdog API ${where}: ${e.message}`)));
        s.on('close', () => finish(new Error(`watchdog API ${where}: closed without an answer`)));
    });
}

/**
 * The event log: newest first, at most `max`; the line's `type` is not kept.
 *
 * @param {object[]} list
 * @param {object} e an event line from the API
 * @param {number} max
 */
function pushEvent(list, e, max) {
    // eslint-disable-next-line no-unused-vars
    const { type, ...event } = e;
    return [event, ...list].slice(0, max);
}

module.exports = { WatchdogClient, defaultApiPath, request, pushEvent };
