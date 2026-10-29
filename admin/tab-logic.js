'use strict';
// The admin tab's view of the redundant pair, from the redundancy instances' states. Plain
// functions over plain data: the tab (tab.html) renders them, test/tab-logic.test.js checks them.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.RedundancyTab = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    const MODES = ['none', 'cold', 'hot'];
    /** A standby counts as ready while its heartbeat links see the primary. */
    const PEER_OK = ['Ok', 'Degraded'];

    function parseMap(text) {
        try {
            const v = JSON.parse(text || '{}');
            return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        } catch {
            return {};
        }
    }

    function parseList(text) {
        try {
            const v = JSON.parse(text || '[]');
            return Array.isArray(v) ? v : [];
        } catch {
            return [];
        }
    }

    /**
     * @param {Array<{n: string, host: string}>} instances redundancy.<n> and its ioBroker host
     * @param {Record<string, {val: unknown}>} states state id → state
     */
    function servers(instances, states) {
        return instances
            .map(({ n, host }) => {
                const p = `redundancy.${n}`;
                const val = id => (states[`${p}.${id}`] ? states[`${p}.${id}`].val : undefined);
                return {
                    instance: p,
                    iobHost: host,
                    name: String(val('watchdogHost') || host),
                    connected: val('info.connection') === true,
                    role: String(val('role') || 'offline'),
                    primary: String(val('primary') || ''),
                    epoch: Number(val('epoch')) || 0,
                    peer: String(val('peer') || ''),
                    clientIssues: parseList(val('clientOptions')).length,
                    engine: String(val('engineVersion') || ''),
                    maintenanceUntil: Number(val('maintenanceUntil')) || 0,
                    installed: parseMap(val('installedAdapters')),
                    config: parseMap(val('watchdogConfig')),
                    links: parseList(val('links')),
                    clientList: parseList(val('clientOptions')),
                    licence: parseMap(val('license.info')),
                    health: parseMap(val('health')),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    function summary(list, now) {
        const up = list.filter(s => s.connected);
        const primaries = up.filter(s => s.role === 'primary');
        const ready = up.filter(s => s.role === 'standby' && PEER_OK.includes(s.peer));
        const until = Math.max(0, ...list.map(s => s.maintenanceUntil));
        const maintenanceUntil = until > now ? until : 0;
        let text;
        let redundant = false;
        if (primaries.length === 0) {
            text = 'No primary';
        } else if (primaries.length > 1) {
            text = `${primaries.length} primaries: ${primaries.map(s => s.name).join(', ')}`;
        } else if (ready.length === 0) {
            text = `Not redundant: ${primaries[0].name} runs alone`;
        } else {
            redundant = true;
            text = `Redundant · ${ready.length + 1} of ${list.length} servers ready`;
        }
        return { redundant, text, primary: primaries.length === 1 ? primaries[0] : null, maintenanceUntil };
    }

    /** Standbys a planned switchover may go to; sent through the primary's instance. */
    function switchTargets(list) {
        const primary = list.find(s => s.connected && s.role === 'primary');
        if (!primary) {
            return [];
        }
        return list
            .filter(s => s.connected && s.role === 'standby' && PEER_OK.includes(s.peer))
            .map(s => ({ name: s.name, via: primary.instance }));
    }

    function mergeEvents(byHost, max) {
        return byHost
            .flatMap(({ host, events }) => (events || []).map(e => ({ ...e, host })))
            .sort((a, b) => (b.t || 0) - (a.t || 0))
            .slice(0, max);
    }

    const secs = ms => `${(Number(ms) / 1000).toFixed(2)} s`;
    const join = parts => parts.filter(Boolean).join(' · ');

    function describeEvent(e) {
        const by = e.by ? `by ${e.by}` : '';
        switch (e.event) {
            case 'switchover':
                return {
                    level: 'info',
                    title: `Planned switchover to ${e.to}`,
                    detail: join([`from ${e.from}`, e.stepsMs && `promoted in ${secs(e.stepsMs.promoted)}`, by]),
                };
            case 'switchover-start':
                return { level: 'info', title: `Planned switchover to ${e.to} started`, detail: join([e.reason, by]) };
            case 'switchover-failed':
                return { level: 'bad', title: `Planned switchover to ${e.to} failed`, detail: join([e.error, by]) };
            case 'failover':
                return { level: 'warn', title: `Failover to ${e.to} started`, detail: `peer ${e.peer}` };
            case 'failover-done':
                return {
                    level: 'warn',
                    title: `Failover to ${e.to}`,
                    detail: join([e.from && `from ${e.from}`, e.promotedMs && `promoted in ${secs(e.promotedMs)}`, e.lease && `lease ${e.lease}`]),
                };
            case 'failover-failed':
                return { level: 'bad', title: 'Failover failed', detail: String(e.error || '') };
            case 'fence':
                return { level: 'bad', title: 'Fenced', detail: String(e.why || '') };
            case 'unfence':
                return { level: 'info', title: 'Unfenced', detail: '' };
            case 'role':
                return { level: 'info', title: `Role: ${e.role}`, detail: '' };
            case 'demote':
                return { level: e.ok ? 'info' : 'warn', title: 'Own Redis demoted', detail: join([`to ${e.to}`, e.error]) };
            case 'maintenance':
                return {
                    level: 'info',
                    title: Number(e.minutes) ? `Maintenance lock for ${e.minutes} min` : 'Maintenance lock lifted',
                    detail: join([e.reason, by]),
                };
            case 'instance':
                return {
                    level: e.state === 'failed' ? (e.critical ? 'bad' : 'warn') : 'info',
                    title: `${e.id} ${e.state === 'failed' ? 'failed' : 'recovered'}${e.host ? ` on ${e.host}` : ''}`,
                    detail: e.critical ? 'critical' : '',
                };
            case 'health':
                return {
                    level: Number(e.failed) ? 'bad' : 'info',
                    title: Number(e.failed) ? `Critical instances failing: ${(e.failing || []).join(', ')}` : 'No critical instance failing',
                    detail: `health ${e.score} %`,
                };
            case 'alarm':
                return { level: 'warn', title: String(e.what || 'alarm'), detail: '' };
            case 'lease':
                return { level: 'info', title: 'Lease taken', detail: String(e.taken || '') };
            case 'start':
                return { level: 'info', title: 'Watchdog started', detail: '' };
            case 'api':
                return { level: 'info', title: 'Local API listening', detail: String(e.listen || '') };
            case 'api-error':
                return { level: 'bad', title: 'Local API not listening', detail: String(e.error || '') };
            default: {
                // eslint-disable-next-line no-unused-vars
                const { t, host, event, ...rest } = e;
                return { level: 'info', title: String(event || 'event'), detail: JSON.stringify(rest) };
            }
        }
    }

    const SERIAL_PATH = /^(\/dev\/(tty|cu\.|serial\/|rfcomm)\S*|COM\d+)$/i;
    const RTU_OVER_TCP = /^(rtu[\s_-]*(over|via)?[\s_-]*tcp|tcp[\s_-]*rtu)$/i;
    /** ioBroker.modbus: native.params.type. */
    const MODBUS_TYPES = ['tcp', 'tcp-ssl', 'serial', 'tcprtu'];

    function findResource(o, depth) {
        if (!o || typeof o !== 'object' || depth > 3) {
            return null;
        }
        for (const v of Object.values(o)) {
            const s = typeof v === 'string' ? v.trim() : '';
            if (SERIAL_PATH.test(s)) {
                return { kind: 'serial', text: `serial line ${s}` };
            }
            if (RTU_OVER_TCP.test(s)) {
                const host = o.host || o.ip || o.bind || o.address || '';
                return { kind: 'single-client', text: `RTU over TCP${host ? ` ${host}${o.port ? `:${o.port}` : ''}` : ''}` };
            }
        }
        for (const v of Object.values(o)) {
            const r = findResource(v, depth + 1);
            if (r) {
                return r;
            }
        }
        return null;
    }

    /**
     * A line only one server may drive, from an instance's settings: a serial bus (one master)
     * or RTU over TCP (the gateway takes one client). Such an instance must not run hot.
     */
    function exclusiveResource(native) {
        const p = native && native.params;
        if (p && MODBUS_TYPES.includes(p.type)) {
            if (p.type === 'serial') {
                return { kind: 'serial', text: `serial line ${p.comName || '(port not set)'}` };
            }
            return p.type === 'tcprtu' ? { kind: 'single-client', text: `RTU over TCP ${p.bind}:${p.port}` } : null;
        }
        return findResource(native, 0);
    }

    /** What can go wrong when this instance runs hot (on every server at once). */
    function hotCheck(row) {
        const out = [];
        if (row.resource) {
            out.push({
                level: 'bad',
                text: row.resource.kind === 'serial'
                    ? `${row.resource.text}: a serial bus has one master; hot would make both servers drive it. Keep it cold.`
                    : `${row.resource.text}: the gateway takes one client; the standby's connection would block or drop the primary's. Keep it cold.`,
            });
        }
        if (!row.hotDeclared) {
            out.push({ level: 'warn', text: `${row.adapter} does not declare hot support: it may write to the device from both servers.` });
        }
        return out;
    }

    /** Every instance but the redundancy ones, with its redundancy mode (unknown = none). */
    function instanceRows(objects) {
        return objects
            .filter(o => o && o._id && !/^system\.adapter\.redundancy\.\d+$/.test(o._id))
            .map(o => {
                const c = o.common || {};
                const mode = c.redundancy && MODES.includes(c.redundancy.mode) ? c.redundancy.mode : 'none';
                const id = o._id.replace(/^system\.adapter\./, '');
                return {
                    id,
                    adapter: id.replace(/\.\d+$/, ''),
                    host: String(c.host || ''),
                    enabled: c.enabled === true,
                    mode,
                    version: typeof c.version === 'string' ? c.version : '',
                    resource: exclusiveResource(o.native),
                    // the adapter's io-package says it holds back on a standby
                    hotDeclared: Boolean(c.redundancy && c.redundancy.hot === true),
                };
            })
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * Where a cold instance could not start, or would start on another version: every other
     * server of the pair (its installed adapters, from installedAdapters).
     */
    function readiness(row, list) {
        // hot moves like cold until the hosts can run it on every server (H3)
        if (row.mode !== 'cold' && row.mode !== 'hot') {
            return [];
        }
        const out = [];
        for (const s of list.filter(x => x.iobHost !== row.host)) {
            const v = s.installed[row.adapter];
            if (!v) {
                out.push({ level: 'bad', text: `${row.adapter} is not installed on ${s.name}` });
            } else if (row.version && v !== row.version) {
                out.push({ level: 'warn', text: `${s.name} has ${row.adapter} ${v}, this instance ${row.version}` });
            }
        }
        return out;
    }

    /** How a server's adapters differ from the other servers'. */
    function adapterDiff(server, list) {
        const missing = [];
        const other = [];
        for (const peer of list.filter(x => x !== server)) {
            for (const [a, v] of Object.entries(peer.installed).sort(([x], [y]) => x.localeCompare(y))) {
                const mine = server.installed[a];
                if (!mine) {
                    missing.push(a);
                } else if (mine !== v) {
                    other.push(`${a} ${mine} (${peer.name}: ${v})`);
                }
            }
        }
        return { missing, other };
    }

    /** The Redis client options every host needs (DESIGN-H1 §2b), with the value needed. */
    const CLIENT_OPTIONS = [
        ['host', 'the 3 Sentinels'],
        ['sentinelName', 'the Sentinel master name'],
        ['retry_max_delay', '150'],
        ['retry_max_count', '100000'],
        ['failoverDetector', 'false'],
        ['connectTimeout', '1000'],
        ['maxRetriesPerRequest', 'null'],
        ['keepAlive', '1000'],
    ];

    /**
     * The Settings view: what each host's watchdog config says, side by side; a value that
     * differs between the hosts is marked (`same: false`).
     */
    function settingsView(list) {
        const withCfg = list.filter(s => s.config && s.config.me);
        const first = withCfg[0] ? withCfg[0].config : {};
        const row = (key, label, get) => {
            const values = {};
            for (const s of withCfg) {
                values[s.name] = get(s.config);
            }
            const all = Object.values(values).map(v => JSON.stringify(v));
            return { key, label, values, same: all.every(v => v === all[0]) };
        };
        const servers = (first.hosts || [])
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map(h => {
                const s = list.find(x => x.name === h.name);
                return { priority: h.priority, name: h.name, iobHost: s ? s.iobHost : '', address: String(h.redis || '').split(':')[0] };
            });
        const t = c => c.timing || {};
        const cluster = [
            row('cluster', 'Cluster', c => c.cluster),
            row('sentinelName', 'Sentinel master name', c => c.sentinelName),
            row('sentinels', 'Sentinels', c => (c.sentinels || []).join(', ')),
            row('witness', 'Witness (Sentinel)', c => c.witness || ''),
            row('witnessRequired', 'Witness required for an automatic failover', c => c.witnessRequired === true),
        ];
        const timing = [
            row('fenceAfterMs', 'Fence after (ms)', c => t(c).fenceAfterMs),
            row('takeoverAfterMs', 'Take over after (ms)', c => t(c).takeoverAfterMs),
            row('leaseTtlMs', 'Lease TTL (ms)', c => t(c).leaseTtlMs),
            row('beatMs', 'Heartbeat every (ms)', c => c.beatMs),
            row('redisHangMs', 'A busy Redis counts as down after (ms)', c => c.redisHangMs),
        ];
        const names = [];
        for (const s of withCfg) {
            for (const l of s.config.links || []) {
                if (!names.includes(l.name)) {
                    names.push(l.name);
                }
            }
        }
        const links = names.map(name => {
            const sides = {};
            const now = {};
            const missedBy = {};
            let medium = '';
            let missed = null;
            for (const s of withCfg) {
                const l = (s.config.links || []).find(x => x.name === name);
                if (l) {
                    sides[s.name] = l.bind;
                    missedBy[s.name] = l.missed == null ? null : l.missed;
                    medium = medium || l.medium;
                    missed = missed == null ? l.missed : missed;
                }
            }
            for (const s of list) {
                const live = s.links.find(x => x.name === name);
                now[s.name] = live ? (live.lost ? 'lost' : 'ok') : '—';
            }
            return { name, medium, sides, lostAfter: missed == null ? (medium === 'wlan' ? 10 : 3) : missed, missed: missedBy, now };
        });
        const clientOptions = CLIENT_OPTIONS.map(([option, needed]) => {
            const values = {};
            for (const s of list) {
                const issues = s.clientList.filter(i => i.option === option);
                values[s.name] = issues.length ? issues.map(i => `${i.found} in ${i.db}`).join(', ') : 'ok';
            }
            const said = list.flatMap(s => s.clientList).find(i => i.option === option && i.needed);
            return { option, needed: said ? String(said.needed) : needed, values };
        });
        return { servers, cluster, timing, links, clientOptions };
    }

    const firstOf = values => Object.values(values || {})[0];
    const rowOf = (rows, key) => rows.find(r => r.key === key) || { values: {}, same: true };

    /** The settings the admin may change (the watchdog's tuning), filled from the servers. */
    function settingsForm(v) {
        const num = key => firstOf(rowOf(v.timing, key).values);
        return {
            fenceAfterMs: num('fenceAfterMs'),
            takeoverAfterMs: num('takeoverAfterMs'),
            leaseTtlMs: num('leaseTtlMs'),
            beatMs: num('beatMs'),
            redisHangMs: num('redisHangMs'),
            witnessRequired: firstOf(rowOf(v.cluster, 'witnessRequired').values) === true,
            missed: Object.fromEntries(v.links.map(l => [l.name, firstOf(l.missed) == null ? null : firstOf(l.missed)])),
        };
    }

    const LIMITS = [
        ['fenceAfterMs', 'Fence after (ms)', 1, 600000],
        ['takeoverAfterMs', 'Take over after (ms)', 1, 600000],
        ['leaseTtlMs', 'Lease TTL (ms)', 1, 600000],
        ['beatMs', 'Heartbeat every (ms)', 10, 1000],
        ['redisHangMs', 'A busy Redis counts as down after (ms)', 1, 60000],
    ];

    /**
     * The form as the watchdog's `settings` request: only what differs from the servers (or
     * what the servers disagree on). With errors, nothing is sent.
     */
    function settingsPatch(v, form) {
        const errors = [];
        const whole = (n, label, lo, hi) => {
            if (!Number.isInteger(n)) {
                errors.push(`${label}: a whole number`);
            } else if (n < lo || n > hi) {
                errors.push(`${label}: ${lo} to ${hi}`);
            }
        };
        for (const [key, label, lo, hi] of LIMITS) {
            whole(form[key], label, lo, hi);
        }
        if (Number.isInteger(form.fenceAfterMs) && Number.isInteger(form.takeoverAfterMs) && form.takeoverAfterMs < form.fenceAfterMs + 50) {
            errors.push('Take over after must be at least 50 ms later than fence after, or two primaries can run at once');
        }
        for (const [name, n] of Object.entries(form.missed || {})) {
            if (n != null) {
                whole(n, `Link ${name}: lost after (beats)`, 1, 100);
            }
        }
        if (errors.length) {
            return { patch: {}, errors };
        }
        const changed = (row, value) => !row.same || firstOf(row.values) !== value;
        const patch = {};
        const timing = {};
        for (const key of ['fenceAfterMs', 'takeoverAfterMs', 'leaseTtlMs']) {
            if (changed(rowOf(v.timing, key), form[key])) {
                timing[key] = form[key];
            }
        }
        if (Object.keys(timing).length) {
            patch.timing = timing;
        }
        for (const key of ['beatMs', 'redisHangMs']) {
            if (changed(rowOf(v.timing, key), form[key])) {
                patch[key] = form[key];
            }
        }
        if (changed(rowOf(v.cluster, 'witnessRequired'), form.witnessRequired)) {
            patch.witnessRequired = form.witnessRequired;
        }
        const links = v.links
            .filter(l => {
                const all = Object.values(l.missed).map(x => (x == null ? null : x));
                const want = form.missed[l.name] == null ? null : form.missed[l.name];
                return all.some(x => x !== all[0]) || all[0] !== want;
            })
            .map(l => ({ name: l.name, missed: form.missed[l.name] == null ? null : form.missed[l.name] }));
        if (links.length) {
            patch.links = links;
        }
        return { patch, errors };
    }

    /** An npm package name of an adapter and a version, nothing a shell would read. */
    const PLAIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;
    const PLAIN_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

    /**
     * Sync: the commands the target host runs (cmdExec, as the admin's adapter installs do)
     * so that it has every adapter of the source in the source's version. Adapters only on the
     * target are left alone; a name or version that is not plain is refused, never run.
     */
    function syncPlan(source, target) {
        const steps = [];
        const refused = [];
        for (const [a, v] of Object.entries(source.installed).sort(([x], [y]) => x.localeCompare(y))) {
            const have = target.installed[a] || '';
            if (have === v) {
                continue;
            }
            if (!PLAIN_NAME.test(a) || !PLAIN_VERSION.test(String(v))) {
                refused.push(a);
                continue;
            }
            steps.push({ adapter: a, have, want: v, cmd: have ? `iobroker upgrade ${a}@${v} -y` : `iobroker install ${a}@${v}` });
        }
        const extra = Object.keys(target.installed).filter(a => !(a in source.installed)).sort();
        return { steps, extra, refused };
    }

    /** The Licence card: each server's licence as its watchdog checked it. */
    function licenceView(list) {
        const rows = list.map(s => ({
            name: s.name,
            state: String(s.licence.state || ''),
            valid: s.licence.valid === true,
            stops: s.licence.stops === true,
            daysLeft: Number(s.licence.daysLeft) || 0,
            message: String(s.licence.message || ''),
            hardwareIds: Array.isArray(s.licence.hardwareIds) ? s.licence.hardwareIds.map(String) : [],
        }));
        const keyed = list.map(s => s.licence).find(l => l.licenseId) || {};
        return {
            rows,
            allValid: rows.length > 0 && rows.every(r => r.valid),
            licenseId: keyed.licenseId || '',
            owner: keyed.owner || '',
            maxServers: keyed.maxServers || null,
            clusterId: keyed.clusterId || '',
            expiresAt: keyed.expiresAt || '',
        };
    }

    /**
     * One activation request for the pair: every server's sealed request in one file, signed
     * as one cluster key (Kamran 2026-10-28). Each request stays as its server made it.
     */
    function activationBundle(cluster, requests, nowMs) {
        if (!requests.length) {
            throw new Error('no server answered');
        }
        return {
            format: 'scada-activation-bundle/1',
            product: 'scada-redundancy',
            cluster,
            createdAtMs: nowMs,
            requests: requests.map(({ server, request }) => {
                try {
                    return JSON.parse(request);
                } catch {
                    throw new Error(`the request of ${server} is not readable`);
                }
            }),
        };
    }

    // ── instance health (RFC-003 §2.11, §2.11a); the adapter checks it again (lib/health.js) ──
    const HEALTH_DEFAULTS = { state: 'info.connection', badWhen: 'false', failures: 3, detectMs: 10000, recoverMs: 30000 };
    const BAD_WHEN = /^(false|true|(>=|<=|>|<|==|!=)\s*-?\d+(\.\d+)?)$/;
    const TARGET = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})$/;
    /** A health report older than this is not shown as now. */
    const HEALTH_STALE_MS = 15000;
    /** Default ports of the device protocols, for the probe target suggestion. */
    const PORTS = { 'rockwell-enip': 44818, rockwell_ethernetip: 44818, modbus: 502, prosoft_flow: 502, opcua: 4840, 'my-opcua': 4840, s7: 102 };

    /**
     * Where the standby could probe the instance's device, from its settings: an
     * `opc.tcp://host:port` endpoint, Modbus `params.bind`/`port`, or a host/IP field with a
     * port field (or the protocol's default port). '' when nothing fits.
     */
    function suggestTarget(native, adapter) {
        const n = native && typeof native === 'object' ? native : {};
        const scan = (o, depth) => {
            if (!o || typeof o !== 'object' || depth > 2) {
                return '';
            }
            for (const v of Object.values(o)) {
                const m = typeof v === 'string' && /^opc\.tcp:\/\/([^/:\s]+):(\d+)/i.exec(v.trim());
                if (m) {
                    return `${m[1]}:${m[2]}`;
                }
            }
            // ip, host, bind, plcHost, tcpHost, deviceAddress …; its port from port / <prefix>Port
            const usable = v => typeof v === 'string' && /^[A-Za-z0-9.-]+$/.test(v.trim()) && v.trim() !== '0.0.0.0';
            const key = Object.keys(o).find(k => /^(ip|host|bind|address|server)$|(Ip|Host|Address)$/.test(k) && usable(o[k]));
            if (key) {
                const prefix = key.replace(/(ip|host|bind|address|server|Ip|Host|Address)$/, '');
                const port = Number(o[`${prefix}Port`]) || Number(o[`${prefix}port`]) || Number(o.port) || PORTS[adapter] || 0;
                if (port > 0 && port < 65536) {
                    return `${o[key].trim()}:${port}`;
                }
            }
            for (const v of Object.values(o)) {
                const r = scan(v, depth + 1);
                if (r) {
                    return r;
                }
            }
            return '';
        };
        return scan(n, 0);
    }

    /** The health settings of an instance as the Instances view edits them. */
    function healthForm(redundancy, native, adapter) {
        const r = redundancy && typeof redundancy === 'object' ? redundancy : {};
        const h = r.health && typeof r.health === 'object' ? r.health : {};
        const v = r.verify && typeof r.verify === 'object' ? r.verify : {};
        const critical = r.critical === true;
        const suggested = suggestTarget(native, adapter);
        return {
            critical,
            onFailure: r.onFailure === 'host' || r.onFailure === 'none' ? r.onFailure : critical ? 'host' : 'none',
            state: typeof h.state === 'string' && h.state ? h.state : HEALTH_DEFAULTS.state,
            badWhen: typeof h.badWhen === 'string' && BAD_WHEN.test(h.badWhen.trim()) ? h.badWhen.trim() : HEALTH_DEFAULTS.badWhen,
            failures: Number.isInteger(h.failures) ? h.failures : HEALTH_DEFAULTS.failures,
            detectS: Number.isInteger(h.detectMs) ? h.detectMs / 1000 : HEALTH_DEFAULTS.detectMs / 1000,
            recoverS: Number.isInteger(h.recoverMs) ? h.recoverMs / 1000 : HEALTH_DEFAULTS.recoverMs / 1000,
            verify: v.kind === 'none' ? 'none' : 'probe',
            target: typeof v.target === 'string' && v.target ? v.target : suggested,
            suggested,
        };
    }

    /** The form → `common.redundancy` fields, or the first thing that is wrong. */
    function healthPatch(f) {
        const state = String(f.state || '').trim();
        if (!/^[\w.-]+$/.test(state)) {
            return { error: 'health state: a state id of the instance, like info.connection' };
        }
        const badWhen = String(f.badWhen || '').trim();
        if (!BAD_WHEN.test(badWhen)) {
            return { error: 'bad when: false, true or a comparison like >= 5' };
        }
        const failures = Number(f.failures);
        if (!Number.isInteger(failures) || failures < 1 || failures > 100) {
            return { error: 'failures: 1 … 100 readings' };
        }
        const detectMs = Math.round(Number(f.detectS) * 1000);
        if (!(detectMs >= 1000 && detectMs <= 600000)) {
            return { error: 'detect: 1 … 600 s' };
        }
        const recoverMs = Math.round(Number(f.recoverS) * 1000);
        if (!(recoverMs >= 0 && recoverMs <= 3600000)) {
            return { error: 'recover: 0 … 3600 s' };
        }
        const target = String(f.target || '').trim();
        const m = TARGET.exec(target);
        if (f.verify === 'probe' && f.critical && !(m && Number(m[2]) >= 1 && Number(m[2]) <= 65535)) {
            return { error: 'check B: a probe needs the device as host:port (or choose none)' };
        }
        return {
            patch: {
                critical: f.critical === true,
                onFailure: f.onFailure === 'host' ? 'host' : 'none',
                health: { state, badWhen, failures, detectMs, recoverMs },
                verify: { kind: f.verify === 'none' ? 'none' : 'probe', target },
            },
        };
    }

    /** `info.connection = false · 3× · 10 s` */
    function signalText(f) {
        return `${f.state} ${/^(false|true)$/.test(f.badWhen) ? `= ${f.badWhen}` : f.badWhen} · ${f.failures}× · ${f.detectS} s`;
    }

    /**
     * What the servers' health reports say about one instance now: where it runs and how it
     * is, whether each standby reaches its device, and why a failure does not move the primary.
     */
    function healthNow(id, list, now) {
        const parts = [];
        let level = 'good';
        const worse = l => {
            if (l === 'bad' || (l === 'warn' && level === 'good')) {
                level = l;
            }
        };
        for (const s of list) {
            const h = s.health;
            if (!h || !h.t || now - Number(h.t) > HEALTH_STALE_MS || !h.instances || !h.instances[id]) {
                continue;
            }
            const i = h.instances[id];
            if (i.state) {
                parts.push(i.state === 'ok' ? `ok on ${s.name}` : `${i.state} on ${s.name}`);
                worse(i.state === 'failed' ? 'bad' : i.state === 'suspect' ? 'warn' : 'good');
            }
            if (i.reach === true) {
                parts.push(`${s.name} reaches the device`);
            } else if (i.reach === false) {
                parts.push(`${s.name} cannot reach the device`);
                worse('warn');
            }
            for (const p of (Array.isArray(h.problems) ? h.problems : []).filter(x => x.id === id)) {
                parts.push(p.why);
                worse('bad');
            }
            if (Array.isArray(h.failing) && h.failing.includes(id)) {
                parts.push(`moves the primary from ${s.name}`);
                worse('bad');
            }
        }
        return parts.length ? { level, text: parts.join(' · ') } : { level: 'dim', text: 'no report yet' };
    }

    return { healthForm, healthPatch, signalText, healthNow, suggestTarget, licenceView, activationBundle, syncPlan, settingsForm, settingsPatch, servers, summary, switchTargets, mergeEvents, describeEvent, instanceRows, exclusiveResource, hotCheck, readiness, adapterDiff, settingsView, MODES, HEALTH_DEFAULTS };
});
