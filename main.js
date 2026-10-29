'use strict';
// iobroker.redundancy — the thin ioBroker side of the redundancy engine. Every decision
// (failover, fencing, lease) is made by the native watchdog service of this host; the
// adapter shows its state and checks this host's settings. Engine: private repository,
// built per platform by CI (prebuilds/<rid>/*.gz).
const fs = require('node:fs');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');

const bridge = require('./lib/nativeBridge');
const { statusToStates, installCommand, STALE_MS, parseSwitchCommand, parseSettingsMessage, settingsSender } = require('./lib/status');
const { reconcile, instanceFromObject, pairHosts } = require('./lib/moves');
const { WatchdogClient, defaultApiPath, request, pushEvent } = require('./lib/api');
const { installedAdapters } = require('./lib/installed');
const { checkPaths, listFiles, diff, writeFile } = require('./lib/syncfiles');
const { healthConfig, parseTarget, Tracker, summarize } = require('./lib/health');
const { tcpProbe } = require('./lib/probe');

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

/** Instance health (RFC-003 §2.11): signals read every HEALTH_MS, the instance list every
 * HEALTH_LIST_MS, a standby probes devices every PROBE_MS, the report goes out every REPORT_MS. */
const HEALTH_MS = 1000;
const HEALTH_LIST_MS = 10_000;
const PROBE_MS = 5000;
const REPORT_MS = 2000;

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
        this.healthTimer = null;
        this.health = { rows: [], others: [], listedAt: 0, probedAt: 0, reportedAt: 0, busy: false, said: '', noToken: false };
        this.trackers = new Map(); // id → {key, tracker, ts, alive}
        this.reach = new Map(); // id → this server's last probe
        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('unload', cb => this.onUnload(cb));
        this.on('message', obj => this.onMessage(obj));
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
        this.healthTimer = setInterval(() => this.healthTick(), HEALTH_MS);
    }

    /** Managed instances with their health settings, and the other servers' redundancy instances. */
    async healthList() {
        const objs = Object.values((await this.getForeignObjectsAsync('system.adapter.*', 'instance')) || {});
        this.health.rows = objs
            .filter(o => /^(cold|hot)$/.test(o.common?.redundancy?.mode) && !/^system\.adapter\.redundancy\.\d+$/.test(o._id))
            .map(o => ({
                id: o._id.replace(/^system\.adapter\./, ''),
                here: o.common.host === this.host && o.common.enabled === true,
                cfg: healthConfig(o.common.redundancy),
            }));
        this.health.others = objs
            .map(o => o._id.replace(/^system\.adapter\./, ''))
            .filter(id => /^redundancy\.\d+$/.test(id) && id !== this.namespace);
    }

    /**
     * Every second: the signal of each managed instance that runs here, a standby's device
     * probes, this server's report (state `health`) and, to the watchdog, the critical
     * instances whose failure moves the primary.
     */
    async healthTick() {
        const h = this.health;
        if (h.busy) {
            return;
        }
        h.busy = true;
        try {
            const now = Date.now();
            if (now - h.listedAt >= HEALTH_LIST_MS) {
                h.listedAt = now;
                await this.healthList();
            }
            const primary = this.last.role === 'primary';
            if (primary) {
                this.reach.clear();
            } else if (now - h.probedAt >= PROBE_MS) {
                h.probedAt = now;
                this.probeDevices(h.rows).catch(() => {});
            }
            const rows = [];
            for (const r of h.rows) {
                rows.push({
                    id: r.id,
                    cfg: r.cfg,
                    state: r.here ? await this.trackSignal(r, now) : undefined,
                    reach: this.reach.get(r.id) ?? null,
                });
            }
            for (const id of this.trackers.keys()) {
                if (!h.rows.some(r => r.here && r.id === id)) {
                    this.trackers.delete(id);
                }
            }
            const peers = [];
            for (const ns of h.others) {
                try {
                    peers.push(JSON.parse((await this.getForeignStateAsync(`${ns}.health`))?.val || 'null'));
                } catch {
                    // not written yet
                }
            }
            const sum = summarize({ rows, primary, peers: peers.filter(Boolean), now });
            const said = JSON.stringify([sum.failing, sum.problems]);
            if (said !== h.said) {
                h.said = said;
                for (const p of sum.problems) {
                    this.log.warn(`${p.id}: ${p.why}`);
                }
                if (sum.failing.length) {
                    this.log.warn(`critical instance(s) failing, the standby checked out: ${sum.failing.join(', ')}`);
                }
            }
            if (now - h.reportedAt >= REPORT_MS) {
                h.reportedAt = now;
                await this.setStateAsync('health', JSON.stringify({ t: now, host: this.host, role: this.last.role || '', ...sum }), true);
                await this.reportHealth(sum);
            }
        } catch (e) {
            this.log.debug(`instance health: ${e.message}`);
        } finally {
            h.busy = false;
        }
    }

    /** One instance's tracker: fed when its signal or `alive` changed, else only the time. */
    async trackSignal(r, now) {
        const key = JSON.stringify(r.cfg.health);
        let t = this.trackers.get(r.id);
        if (!t || t.key !== key) {
            t = { key, tracker: new Tracker(r.cfg.health), ts: null, alive: null };
            this.trackers.set(r.id, t);
        }
        const sig = await this.getForeignStateAsync(`${r.id}.${r.cfg.health.state}`);
        const alive = (await this.getForeignStateAsync(`system.adapter.${r.id}.alive`))?.val === true;
        const before = t.tracker.state;
        if ((sig && sig.ts !== t.ts) || alive !== t.alive) {
            t.ts = sig ? sig.ts : null;
            t.alive = alive;
            t.tracker.feed(sig ? sig.val : null, alive, now);
        } else {
            t.tracker.tick(now);
        }
        const state = t.tracker.state;
        if (state !== before && (state === 'failed' || before === 'failed')) {
            if (state === 'failed') {
                this.log.warn(`${r.id} failed: ${alive ? `${r.cfg.health.state} ${r.cfg.health.badWhen}` : 'not alive'}`);
            } else {
                this.log.info(`${r.id} recovered`);
            }
            this.events = pushEvent(this.events, { t: now, event: 'instance', id: r.id, state, critical: r.cfg.critical, host: this.host }, MAX_EVENTS);
            await this.setStateAsync('events', JSON.stringify(this.events), true);
        }
        return state;
    }

    /** A standby's check that it could reach each critical instance's device. */
    async probeDevices(rows) {
        await Promise.all(
            rows
                .filter(r => r.cfg.critical && r.cfg.verify.kind === 'probe' && r.cfg.verify.target)
                .map(async r => this.reach.set(r.id, await tcpProbe(parseTarget(r.cfg.verify.target), 2000))),
        );
    }

    /** The watchdog takes the score into its heartbeat, and moves the primary on the failures. */
    async reportHealth(sum) {
        if (!this.apiWhere || !this.apiUp) {
            return;
        }
        if (!this.config.apiToken) {
            if (!this.health.noToken) {
                this.health.noToken = true;
                this.log.warn('instance health is not sent to the watchdog: set the watchdog API token in the settings');
            }
            return;
        }
        try {
            const reply = await request(
                this.apiWhere,
                { op: 'health', score: sum.score, failed: sum.failing.length, failing: sum.failing, token: this.config.apiToken },
                2000,
            );
            if (reply.type === 'error') {
                this.log.debug(`health refused by the watchdog: ${reply.error}`);
            }
        } catch (e) {
            this.log.debug(`health: ${e.message}`);
        }
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

    /**
     * sendTo('settings') from the admin tab: new tuning for this host's watchdog (checked, or
     * written and taken over). The tab sends it to every server under a maintenance lock.
     */
    async onMessage(obj) {
        const answer = result => obj && obj.callback && this.sendTo(obj.from, obj.command, result, obj.callback);
        if (obj && obj.command === 'installed') {
            // after a sync the tab wants this host's adapters now, not in up to 10 minutes
            await this.writeInstalled();
            answer({ ok: true, installed: this.installed() });
            return;
        }
        if (obj && /^sync(List|Compare|Send|Receive)$/.test(obj.command)) {
            await this.onSyncMessage(obj, answer);
            return;
        }
        if (obj && (obj.command === 'activation' || obj.command === 'licence')) {
            await this.onLicenceMessage(obj, answer);
            return;
        }
        if (!obj || obj.command !== 'settings') {
            return;
        }
        const msg = parseSettingsMessage(obj.message);
        if (!msg) {
            answer({ error: 'settings: an object of settings is needed' });
            return;
        }
        if (!this.config.apiToken) {
            answer({ error: 'set the watchdog API token in the settings of this instance first' });
            return;
        }
        const by = settingsSender(obj);
        if (!by) {
            this.log.warn(`settings from ${obj.from} refused: only the admin tab may change them`);
            answer({ error: 'only an admin instance may change the watchdog settings' });
            return;
        }
        try {
            const reply = await request(this.apiWhere, { op: 'settings', ...msg, by, token: this.config.apiToken });
            if (reply.type === 'error') {
                answer({ error: reply.error });
                return;
            }
            if (!msg.dryRun) {
                this.log.info(`watchdog settings changed by ${by}: ${JSON.stringify(msg.settings)}`);
                await this.refreshConfig();
            }
            answer({ ok: true, config: reply.config });
        } catch (e) {
            answer({ error: e.message });
        }
    }

    /**
     * Sync of local files (the admin tab's Sync card), from an admin instance only:
     * syncList / syncCompare on either server for the dry run; syncSend on the source puts the
     * files into its `sync` meta object (Redis), syncReceive on the target writes them under its
     * iobroker-data and removes them there.
     */
    async onSyncMessage(obj, answer) {
        const by = settingsSender(obj);
        if (!by) {
            this.log.warn(`${obj.command} from ${obj.from} refused: only the admin tab may sync`);
            answer({ error: 'only an admin instance may sync' });
            return;
        }
        const m = obj.message || {};
        const root = utils.getAbsoluteDefaultDataDir();
        try {
            if (obj.command === 'syncList' || obj.command === 'syncSend') {
                const { ok, refused } = checkPaths(Array.isArray(m.paths) ? m.paths : []);
                const { files, total } = listFiles(root, ok);
                if (obj.command === 'syncList') {
                    answer({ ok: true, files, total, refused });
                    return;
                }
                const only = Array.isArray(m.only) ? new Set(m.only) : null;
                const id = String(m.id || Date.now()).replace(/[^0-9A-Za-z-]/g, '');
                const sent = [];
                for (const f of files.filter(x => !only || only.has(x.path))) {
                    await this.writeFileAsync(`${this.namespace}.sync`, `${id}/${f.path}`, fs.readFileSync(path.join(root, f.path)));
                    sent.push(f.path);
                }
                this.log.info(`sync: ${sent.length} files ready for the other server (${by})`);
                answer({ ok: true, id, files: sent });
            } else if (obj.command === 'syncCompare') {
                const src = Array.isArray(m.files) ? m.files : [];
                const { files } = listFiles(root, checkPaths([...new Set(src.map(f => String(f.path).split('/')[0]))]).ok);
                answer({ ok: true, diff: diff(src, files) });
            } else {
                const from = String(m.from || '');
                const id = String(m.id || '').replace(/[^0-9A-Za-z-]/g, '');
                if (!/^redundancy\.\d+$/.test(from) || !id) {
                    answer({ error: 'syncReceive: from and id are needed' });
                    return;
                }
                const written = [];
                const failed = [];
                for (const p of Array.isArray(m.files) ? m.files : []) {
                    try {
                        const { file } = await this.readFileAsync(`${from}.sync`, `${id}/${p}`);
                        writeFile(root, p, Buffer.isBuffer(file) ? file : Buffer.from(file));
                        written.push(p);
                    } catch (e) {
                        failed.push(`${p}: ${e.message}`);
                    }
                    await this.delFileAsync(`${from}.sync`, `${id}/${p}`).catch(() => {});
                }
                this.log.info(`sync: ${written.length} files written from ${from}${failed.length ? `, ${failed.length} failed` : ''} (${by})`);
                answer({ ok: failed.length === 0, written, failed });
            }
        } catch (e) {
            answer({ error: e.message });
        }
    }

    /**
     * The Licence card of the admin tab: this server's activation request (the tab bundles
     * every server's into one file), and the cluster's key for this server's watchdog,
     * which checks it itself. Both from an admin instance only.
     */
    async onLicenceMessage(obj, answer) {
        const by = settingsSender(obj);
        if (!by) {
            this.log.warn(`${obj.command} from ${obj.from} refused: only the admin tab may ask`);
            answer({ error: 'only an admin instance may do this' });
            return;
        }
        let req;
        if (obj.command === 'activation') {
            req = { op: 'activation' };
        } else {
            const key = obj.message && typeof obj.message.key === 'string' ? obj.message.key.trim() : null;
            if (key === null || key.length > 3500) {
                answer({ error: 'licence: the key (or the activation response file) is needed' });
                return;
            }
            if (!this.config.apiToken) {
                answer({ error: 'set the watchdog API token in the settings of this instance first' });
                return;
            }
            req = { op: 'licence', key, token: this.config.apiToken };
        }
        try {
            const reply = await request(this.apiWhere, req);
            if (reply.type === 'error') {
                answer({ error: reply.error });
                return;
            }
            if (obj.command === 'licence') {
                this.log.info(`licence key ${req.key ? 'entered' : 'removed'} by ${by}: ${reply.state} (${reply.message})`);
            }
            // eslint-disable-next-line no-unused-vars
            const { type, ...body } = reply;
            answer({ ok: true, ...body });
        } catch (e) {
            answer({ error: e.message });
        }
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
            if (this.healthTimer) {
                clearInterval(this.healthTimer);
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
