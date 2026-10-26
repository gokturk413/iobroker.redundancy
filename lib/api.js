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

module.exports = { WatchdogClient, defaultApiPath };
