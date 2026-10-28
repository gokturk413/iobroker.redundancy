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
            let medium = '';
            let missed = null;
            for (const s of withCfg) {
                const l = (s.config.links || []).find(x => x.name === name);
                if (l) {
                    sides[s.name] = l.bind;
                    medium = medium || l.medium;
                    missed = missed == null ? l.missed : missed;
                }
            }
            for (const s of list) {
                const live = s.links.find(x => x.name === name);
                now[s.name] = live ? (live.lost ? 'lost' : 'ok') : '—';
            }
            return { name, medium, sides, lostAfter: missed == null ? (medium === 'wlan' ? 10 : 3) : missed, now };
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

    return { servers, summary, switchTargets, mergeEvents, describeEvent, instanceRows, exclusiveResource, hotCheck, readiness, adapterDiff, settingsView, MODES };
});
