'use strict';
// The standby's check of a device (RFC-003 §2.11 verifyStandby "probe"): a TCP connect to
// host:port that is closed at once. Nothing is sent, so the device sees no request.
const net = require('node:net');

/**
 * @param {{host: string, port: number}} target
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} the device accepted the connection
 */
function tcpProbe(target, timeoutMs = 2000) {
    return new Promise(resolve => {
        const s = net.connect({ host: target.host, port: target.port });
        const done = ok => {
            s.removeAllListeners();
            s.on('error', () => {});
            s.destroy();
            resolve(ok);
        };
        s.setTimeout(timeoutMs, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

module.exports = { tcpProbe };
