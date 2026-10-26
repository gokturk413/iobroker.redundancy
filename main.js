'use strict';
// iobroker.redundancy — the thin ioBroker side of the redundancy engine. Every decision
// (failover, fencing, lease) is made by the native watchdog service of this host; the
// adapter shows its state and checks this host's settings. Engine: private repository,
// built per platform by CI (prebuilds/<rid>/*.gz).
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');

const bridge = require('./lib/nativeBridge');
const { statusToStates, installCommand } = require('./lib/status');
const { reconcile, instanceFromObject, pairHosts } = require('./lib/moves');

const POLL_MS = 1000;
/** A primary checks this often that every cold instance is here (and at once on a switch). */
const RECONCILE_MS = 5000;

class Redundancy extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'redundancy' });
        this.timer = null;
        this.last = {};
        this.addon = null;
        this.moving = false;
        this.lastReconcile = 0;
        this.lastSwitch = '';
        this.on('ready', () => this.onReady());
        this.on('unload', cb => this.onUnload(cb));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        let addon;
        try {
            addon = bridge.loadAddon();
            this.addon = addon;
            await this.setStateAsync('engineVersion', addon.version(), true);
        } catch (e) {
            this.log.error(`native engine: ${e.message}`);
            return;
        }
        await this.checkClientOptions(addon);

        try {
            const exe = bridge.watchdogPath();
            const config = this.config.statusFile
                ? path.join(path.dirname(this.config.statusFile), 'watchdog.json')
                : '<watchdog.json>';
            await this.setStateAsync('watchdogInstall', installCommand(process.platform, exe, config), true);
        } catch (e) {
            this.log.error(`watchdog: ${e.message}`);
        }

        if (!this.config.statusFile) {
            this.log.warn('no watchdog status file set: the role of this host is unknown (settings → status file)');
            return;
        }
        this.timer = setInterval(() => this.poll(), POLL_MS);
        this.poll();
    }

    async checkClientOptions(addon) {
        const file = this.config.iobrokerJson || path.join(utils.getAbsoluteDefaultDataDir(), 'iobroker.json');
        try {
            const issues = JSON.parse(addon.checkClientOptions(fs.readFileSync(file, 'utf8')));
            await this.setStateAsync('clientOptions', JSON.stringify(issues), true);
            for (const i of issues) {
                const text = `${file}: ${i.db}.options ${i.option} is ${i.found}, a switch needs ${i.needed}`;
                if (i.severity === 'error') {
                    this.log.error(text);
                } else {
                    this.log.warn(text);
                }
            }
        } catch (e) {
            this.log.warn(`cannot check ${file}: ${e.message}`);
        }
    }

    async poll() {
        let status = null;
        try {
            status = JSON.parse(fs.readFileSync(this.config.statusFile, 'utf8'));
        } catch {
            // not written yet, or the watchdog is not running: statusToStates says offline
        }
        const states = statusToStates(status, Date.now());
        for (const [id, val] of Object.entries(states)) {
            if (this.last[id] !== val) {
                this.last[id] = val;
                await this.setStateAsync(id, val, true);
            }
        }
        this.maybeReconcile(states);
    }

    /** On the primary: at once after a role or epoch change, else every RECONCILE_MS. */
    maybeReconcile(states) {
        const sw = `${states.role}:${states.epoch}`;
        const due = sw !== this.lastSwitch || Date.now() - this.lastReconcile >= RECONCILE_MS;
        if (this.moving || !this.addon || states.role !== 'primary' || !due) {
            return;
        }
        this.lastSwitch = sw;
        this.lastReconcile = Date.now();
        this.moving = true;
        reconcile({ status: { role: states.role, peer: states.peer }, me: this.host, addon: this.addon, io: this.io() })
            .then(results => this.reportMoves(results))
            .catch(e => this.log.error(`moving cold instances: ${e.message}`))
            .finally(() => {
                this.moving = false;
            });
    }

    async reportMoves(results) {
        if (!results.length) {
            return;
        }
        for (const r of results) {
            const how = r.waitedMs ? ` after ${r.waitedMs} ms for the old copy${r.timedOut ? ' (it did not stop)' : ''}` : '';
            if (r.ok) {
                this.log.info(`moved ${r.id} from ${r.from} to ${this.host}${how}`);
            } else {
                this.log.error(`could not move ${r.id} from ${r.from}: ${r.error}`);
            }
        }
        await this.setStateAsync('lastMoves', JSON.stringify({ t: Date.now(), to: this.host, moves: results }), true);
    }

    /** Object and state access for lib/moves.js. */
    io() {
        const sys = id => `system.adapter.${id}`;
        const all = async () =>
            Object.values(
                (await this.getForeignObjectsAsync('system.adapter.*', 'instance')) || {},
            );
        return {
            getInstances: async () => (await all()).map(instanceFromObject).filter(Boolean),
            getPair: async () => pairHosts(await all()),
            extend: (id, common) => this.extendForeignObjectAsync(sys(id), { common }),
            isAlive: async id => (await this.getForeignStateAsync(`${sys(id)}.alive`))?.val === true,
            clearSigKill: id => this.delForeignStateAsync(`${sys(id)}.sigKill`).catch(() => {}),
            setNotAlive: id => this.setForeignStateAsync(`${sys(id)}.alive`, false, true),
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
            now: () => Date.now(),
        };
    }

    onUnload(callback) {
        try {
            if (this.timer) {
                clearInterval(this.timer);
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Redundancy(options);
} else {
    new Redundancy();
}
