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

const POLL_MS = 1000;

class Redundancy extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'redundancy' });
        this.timer = null;
        this.last = {};
        this.on('ready', () => this.onReady());
        this.on('unload', cb => this.onUnload(cb));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        let addon;
        try {
            addon = bridge.loadAddon();
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
