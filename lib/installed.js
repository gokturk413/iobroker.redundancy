'use strict';
// The adapters installed on this host. The instance objects and their settings are shared
// by all hosts (in Redis), but each host has its own node_modules: a cold instance can only
// start on a host that has its adapter.
const fs = require('node:fs');
const path = require('node:path');

/** Not adapters, though named so. */
const NOT_ADAPTERS = new Set(['js-controller']);

/**
 * @param {string} nodeModules the node_modules folder of this ioBroker installation
 * @returns {Record<string, string>} adapter name → version
 */
function installedAdapters(nodeModules) {
    let dirs;
    try {
        dirs = fs.readdirSync(nodeModules);
    } catch {
        return {};
    }
    const out = {};
    for (const d of dirs.filter(d => d.startsWith('iobroker.')).sort()) {
        const name = d.slice('iobroker.'.length);
        if (NOT_ADAPTERS.has(name)) {
            continue;
        }
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(nodeModules, d, 'package.json'), 'utf8'));
            if (typeof pkg.version === 'string') {
                out[name] = pkg.version;
            }
        } catch {
            // a half-installed package: not usable here
        }
    }
    return out;
}

/**
 * @param {Record<string, string>} here
 * @param {Record<string, string>} there
 * @returns {{missing: string[], other: Array<{adapter: string, here: string, there: string}>}}
 */
function differences(here, there) {
    const missing = [];
    const other = [];
    for (const [adapter, v] of Object.entries(here).sort(([a], [b]) => a.localeCompare(b))) {
        if (!(adapter in there)) {
            missing.push(adapter);
        } else if (there[adapter] !== v) {
            other.push({ adapter, here: v, there: there[adapter] });
        }
    }
    return { missing, other };
}

/**
 * Does this host run ioBroker in a container (docker, podman, containerd)? Then its
 * node_modules are inside the image: an `iobroker install`/`upgrade` reaches only this
 * container and is gone when it is recreated, so the Sync tab does not run one here (the
 * image is rebuilt instead: lab/h0-vm/upgrade-adapter.sh).
 *
 * @param {{exists?: (p: string) => boolean, read?: (p: string) => string, env?: NodeJS.ProcessEnv}} [io]
 * @returns {boolean}
 */
function inContainer(io = {}) {
    const exists = io.exists || (p => fs.existsSync(p));
    const read = io.read || (p => fs.readFileSync(p, 'utf8'));
    const env = io.env || process.env;
    if (env.container || exists('/.dockerenv') || exists('/run/.containerenv')) {
        return true;
    }
    try {
        return /docker|containerd|kubepods|libpod/.test(read('/proc/1/cgroup'));
    } catch {
        return false;
    }
}

module.exports = { installedAdapters, differences, inContainer };
