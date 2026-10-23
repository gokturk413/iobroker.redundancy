'use strict';
// Turning the watchdog's status file into the adapter's states. The watchdog writes the
// file every 250 ms; older than STALE_MS means it is not running.

const STALE_MS = 3000;

/**
 * @param {object|null} status parsed status file of the watchdog
 * @param {number} now ms since epoch
 * @returns {Record<string, string|number|boolean>} state id (relative) → value
 */
function statusToStates(status, now) {
    const running = Boolean(status && typeof status.t === 'number' && now - status.t <= STALE_MS);
    if (!running) {
        return { 'info.connection': false, role: 'offline' };
    }
    return {
        'info.connection': true,
        role: String(status.role || 'offline'),
        primary: status.master ? String(status.master) : '',
        epoch: Number(status.epoch) || 0,
        peer: String(status.peer || ''),
    };
}

/**
 * The one-time command that registers the watchdog as this OS's service.
 *
 * @param {string} platform process.platform
 * @param {string} exe expanded watchdog path
 * @param {string} config watchdog config path
 */
function installCommand(platform, exe, config) {
    const cmd = `"${exe}" install "${config}"`;
    return platform === 'win32' ? `${cmd}   (admin shell)` : `sudo ${cmd}`;
}

module.exports = { STALE_MS, statusToStates, installCommand };
