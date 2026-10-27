'use strict';
// iobroker.redundancy — the thin ioBroker side of the redundancy engine. Every decision
// (failover, fencing, lease) is made by the native watchdog service of this host; the
// adapter shows its state and checks this host's settings. Engine: private repository,
// built per platform by CI (prebuilds/<rid>/*.gz).
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');

const bridge = require('./lib/nativeBridge');
const { statusToStates, installCommand, STALE_MS, parseSwitchCommand } = require('./lib/status');
const { reconcile, instanceFromObject, pairHosts } = require('./lib/moves');
const { WatchdogClient, defaultApiPath, request, pushEvent } = require('./lib/api');
const { installedAdapters } = require('./lib/installed');

/** How often the watchdog config is read again (it changes only when someone edits it). */
const CONFIG_MS = 60_000;
/** How often this host's installed adapters are written to the installedAdapters state. */
const INSTALLED_MS = 10 * 60_000;

/** Events kept in the `events` state. */
const MAX_EVENTS = 100;

/** Events that go to the log as warnings; the rest is info, lease errors are debug. */
const WARN_EVENTS = new Set(['alarm', 'fence', 'failover-failed', 'api-error']);

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
        this.api = null;
        this.apiUp = false;
        this.apiStatus = null;
        this.apiWhere = null;
        this.events = [];
        this.skipsSaid = new Map();
        this.installedTimer = null;
        this.configTimer = null;
        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('unload', cb => this.onUnload(cb));
    }

    async onReady() {
        await this.ensureObjects();
        await this.writeInstalled();
        this.installedTimer = setInterval(() => this.writeInstalled().catch(() => {}), INSTALLED_MS);
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
        const where = this.config.apiSocket || defaultApiPath(this.config.statusFile, process.platform);
        if (where) {
            this.apiWhere = where;
            try {
                this.events = JSON.parse((await this.getStateAsync('events'))?.val || '[]');
            } catch {
                this.events = [];
            }
            this.startApi(where);
            this.subscribeStates('control.*');
        }
        this.timer = setInterval(() => this.poll(), POLL_MS);
        this.poll();
    }

    /** This host's node_modules (the folder this adapter is installed in). */
    installed() {
        return installedAdapters(path.join(__dirname, '..'));
    }

    async writeInstalled() {
        await this.setStateAsync('installedAdapters', JSON.stringify(this.installed()), true);
    }

    /**
     * The states of io-package.json that this instance does not have yet: js-controller adds
     * them on an install or upgrade, not when the files are replaced by hand (lab, 2026-10-26:
     * redundancy.1 had none of the new states).
     */
    async ensureObjects() {
        for (const o of require('./io-package.json').instanceObjects) {
            const { _id, ...obj } = o;
            await this.setObjectNotExistsAsync(_id, obj);
        }
    }

    /** The watchdog's local API: its events at once, its status every 500 ms. */
    startApi(where) {
        this.api = new WatchdogClient(where);
        this.api.on('status', s => {
            this.apiStatus = s;
        });
        this.api.on('event', e => this.onWatchdogEvent(e));
        this.api.on('up', () => {
            this.apiUp = true;
            this.refreshConfig();
            this.log.info(`watchdog API connected: ${where}`);
        });
        this.api.on('down', () => {
            this.apiStatus = null;
            if (this.apiUp) {
                this.apiUp = false;
                this.log.warn(`watchdog API lost: ${where} (the status file is read meanwhile)`);
            }
        });
        this.api.start();
        this.configTimer = setInterval(() => this.refreshConfig(), CONFIG_MS);
    }

    /** The watchdog config without its secrets, for the settings view of the admin tab. */
    async refreshConfig() {
        try {
            const reply = await request(this.apiWhere, { op: 'config' }, 5000);
            if (reply.type !== 'config') {
                return;
            }
            // eslint-disable-next-line no-unused-vars
            const { type, ...cfg } = reply;
            const text = JSON.stringify(cfg);
            if (text !== this.last.watchdogConfig) {
                this.last.watchdogConfig = text;
                await this.setStateAsync('watchdogConfig', text, true);
            }
        } catch (e) {
            this.log.debug(`watchdog config: ${e.message}`);
        }
    }

    onWatchdogEvent(e) {
        // eslint-disable-next-line no-unused-vars
        const { type, t, event, ...rest } = e;
        const text = `watchdog: ${event} ${JSON.stringify(rest)}`;
        if (WARN_EVENTS.has(event)) {
            this.log.warn(text);
        } else if (event === 'lease-error') {
            this.log.debug(text);
        } else {
            this.log.info(text);
        }
        if (event === 'role') {
            this.poll(); // the new role now, not up to a second later
        }
        if (event !== 'lease-error') {
            this.events = pushEvent(this.events, e, MAX_EVENTS);
            this.setState('events', JSON.stringify(this.events), true);
        }
        if (event === 'switchover') {
            this.setState('lastSwitch', JSON.stringify({ t, ...rest }), true);
        }
    }

    /** The operator's commands: a planned switchover, the maintenance lock. */
    async onStateChange(id, state) {
        if (!state || state.ack || !id.startsWith(`${this.namespace}.control.`)) {
            return;
        }
        const what = id.slice(this.namespace.length + 'control.'.length + 1);
        const by = state.user ? String(state.user).replace(/^system\.user\./, '') : String(state.from || '');
        let req;
        if (what === 'switchover') {
            const cmd = parseSwitchCommand(state.val);
            if (!cmd) {
                return;
            }
            req = { op: 'switchover', to: cmd.to, by, reason: cmd.reason || `${what} from ${state.from || 'unknown'}` };
        } else if (what === 'maintenance') {
            const minutes = Math.max(0, Math.round(Number(state.val) || 0));
            req = { op: 'maintenance', minutes, by, reason: `${what} from ${state.from || 'unknown'}` };
        } else {
            return;
        }
        if (!this.config.apiToken) {
            this.log.error(`${what} refused: set the watchdog API token in the settings (apiToken of the watchdog config)`);
            await this.setStateAsync(id, what === 'switchover' ? '' : 0, true);
            return;
        }
        this.log.info(`${what} requested by ${by}: ${JSON.stringify(req)}`);
        try {
            const reply = await request(this.apiWhere, { ...req, token: this.config.apiToken });
            if (reply.type === 'error') {
                this.log.error(`${what} refused by the watchdog: ${reply.error}`);
            } else if (reply.type === 'maintenance') {
                await this.setStateAsync('maintenanceUntil', Number(reply.until) || 0, true);
            }
        } catch (e) {
            this.log.error(`${what}: ${e.message}`);
        }
        // the command is done (or refused): the command state shows its value acknowledged
        await this.setStateAsync(id, what === 'switchover' ? '' : req.minutes, true);
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
        let file = null;
        try {
            file = JSON.parse(fs.readFileSync(this.config.statusFile, 'utf8'));
        } catch {
            // not written yet, or the watchdog is not running: statusToStates says offline
        }
        const now = Date.now();
        const fresh = this.apiStatus && now - this.apiStatus.t <= STALE_MS;
        const states = statusToStates(fresh ? this.apiStatus : file, now);
        // moves act on the status file too: only the watchdog can write its folder, while
        // a socket or pipe name could be taken by someone else
        this.fileRole = statusToStates(file, now).role;
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
        const primary = states.role === 'primary' && this.fileRole === 'primary';
        if (this.moving || !this.addon || !primary || !due) {
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

    async reportMoves({ moves, skipped }) {
        for (const r of moves) {
            const how = r.waitedMs ? ` after ${r.waitedMs} ms for the old copy${r.timedOut ? ' (it did not stop)' : ''}` : '';
            if (r.ok) {
                this.log.info(`moved ${r.id} from ${r.from} to ${this.host}${how}`);
                if (r.warning) {
                    this.log.warn(`${r.id}: ${r.warning}`);
                }
            } else {
                this.log.error(`could not move ${r.id} from ${r.from}: ${r.error}`);
            }
        }
        // a primary checks every few seconds: say each held-back instance once, not each time
        const newSkips = skipped.filter(k => this.skipsSaid.get(k.id) !== k.reason);
        this.skipsSaid = new Map(skipped.map(k => [k.id, k.reason]));
        for (const k of newSkips) {
            this.log.error(`${k.id} stays where it is: ${k.reason}`);
        }
        if (moves.length || newSkips.length) {
            await this.setStateAsync('lastMoves', JSON.stringify({ t: Date.now(), to: this.host, moves, skipped }), true);
        }
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
            getInstalled: async () => this.installed(),
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
            if (this.installedTimer) {
                clearInterval(this.installedTimer);
            }
            if (this.configTimer) {
                clearInterval(this.configTimer);
            }
            this.api?.stop();
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
