'use strict';
// The native parts of the redundancy engine, built and released by the private engine
// repository: per platform `prebuilds/<rid>/redundancy.node.gz` (napi addon) and
// `prebuilds/<rid>/redundancy-watchdog[.exe].gz` (the watchdog service). ioBroker review
// rule: only the files of the installing host are expanded, on first use.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const RIDS = ['win-x64', 'linux-x64', 'linux-arm64', 'osx-arm64', 'osx-x64'];
const ROOT = path.join(__dirname, '..');

/**
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @returns {string|null} the prebuild folder name, null when there is none
 */
function ridFor(platform, arch) {
    const rid = { win32: 'win', linux: 'linux', darwin: 'osx' }[platform];
    const r = rid && `${rid}-${arch}`;
    return RIDS.includes(r) ? r : null;
}

/** @param {string} rid */
function watchdogName(rid) {
    return rid.startsWith('win-') ? 'redundancy-watchdog.exe' : 'redundancy-watchdog';
}

/**
 * Expands `<file>.gz` next to it (or into the temp folder when the package folder is
 * read-only) and returns the expanded path. A file newer than the archive is kept.
 *
 * @param {string} gz path of the archive
 * @param {number} mode file mode of the expanded file
 */
function expand(gz, mode) {
    if (!fs.existsSync(gz)) {
        throw new Error(`${gz} is missing from the package`);
    }
    const target = gz.slice(0, -3);
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(gz).mtimeMs) {
        return target;
    }
    const data = zlib.gunzipSync(fs.readFileSync(gz));
    try {
        fs.writeFileSync(target, data, { mode });
        fs.chmodSync(target, mode);
        return target;
    } catch {
        const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
        const dir = path.join(os.tmpdir(), 'iobroker.redundancy', hash);
        fs.mkdirSync(dir, { recursive: true });
        const cached = path.join(dir, path.basename(target));
        if (!fs.existsSync(cached)) {
            fs.writeFileSync(cached, data, { mode });
            fs.chmodSync(cached, mode);
        }
        return cached;
    }
}

function folder({ root = ROOT, rid = ridFor(process.platform, process.arch) } = {}) {
    if (!rid) {
        throw new Error(
            `redundancy: ${process.platform}-${process.arch} is not supported (supported: ${RIDS.join(', ')})`,
        );
    }
    return { dir: path.join(root, 'prebuilds', rid), rid };
}

/**
 * The watchdog executable of this host, expanded.
 *
 * @param {{root?: string, rid?: string|null}} [where] package root and platform (tests)
 */
function watchdogPath(where) {
    const { dir, rid } = folder(where);
    return expand(path.join(dir, `${watchdogName(rid)}.gz`), 0o755);
}

/**
 * The napi addon of this host: `version()`, `checkClientOptions(iobrokerJson)`.
 *
 * @param {{root?: string, rid?: string|null}} [where] package root and platform (tests)
 */
function loadAddon(where) {
    const { dir } = folder(where);
    const file = expand(path.join(dir, 'redundancy.node.gz'), 0o644);
    const m = { exports: {} };
    process.dlopen(m, file);
    return m.exports;
}

module.exports = { RIDS, ridFor, watchdogName, watchdogPath, loadAddon };
