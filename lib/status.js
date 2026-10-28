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
        maintenanceUntil: Number(status.maintenanceUntil) || 0,
        watchdogHost: String(status.me || ''),
        // lost or not only: the age changes with every beat and would rewrite the state
        links: JSON.stringify((Array.isArray(status.links) ? status.links : []).map(l => ({ name: String(l.name), lost: l.lost === true }))),
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

/** Longest reason kept with a switchover. */
const MAX_REASON = 500;

/**
 * control.switchover: the target host name of the watchdog config, or JSON
 * {"to": "B", "reason": "..."} (the admin tab sends that).
 *
 * @param {unknown} val the state's value
 * @returns {{to: string, reason: string} | null}
 */
function parseSwitchCommand(val) {
    const text = String(val ?? '').trim();
    if (!text) {
        return null;
    }
    if (!text.startsWith('{')) {
        return { to: text, reason: '' };
    }
    try {
        const o = JSON.parse(text);
        const to = String(o.to ?? '').trim();
        return to ? { to, reason: String(o.reason ?? '').slice(0, MAX_REASON) } : null;
    } catch {
        return null;
    }
}

/** The watchdog reads requests of at most 4096 bytes; the token and op need some of it. */
const MAX_SETTINGS = 3000;

/**
 * sendTo('settings') from the admin tab: the watchdog's tuning to change (it checks every
 * field itself) and whether only to check it.
 *
 * @param {unknown} message obj.message
 * @returns {{settings: object, dryRun: boolean} | null}
 */
function parseSettingsMessage(message) {
    const s = message && message.settings;
    if (!s || typeof s !== 'object' || Array.isArray(s) || JSON.stringify(s).length > MAX_SETTINGS) {
        return null;
    }
    return { settings: s, dryRun: message.dryRun === true };
}

module.exports = { STALE_MS, statusToStates, installCommand, parseSwitchCommand, parseSettingsMessage };
