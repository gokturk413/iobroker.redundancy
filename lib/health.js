'use strict';
// Instance health (RFC-003 §2.11, §2.11a). The adapter of each server watches the health
// signal of the managed instances that run there and, on a standby, checks that it could
// reach their devices. The primary's adapter tells its watchdog how many critical instances
// fail here while the standby checks out; the watchdog's policy decides the switch.

/** RFC-003 §2.11a defaults. */
const DEFAULTS = Object.freeze({
    state: 'info.connection',
    badWhen: 'false',
    failures: 3,
    detectMs: 10_000,
    recoverMs: 30_000,
});

/** A report of another server older than this counts as none. */
const REPORT_STALE_MS = 15_000;

const ON_FAILURE = new Set(['host', 'none']);
const VERIFY = new Set(['probe', 'none']);

/**
 * `badWhen` → a test of the state value. Only these forms, never code: `false`, `true`,
 * or a comparison with a number (`>= 5`, `< 1`, `== 0`, `!= 2`).
 *
 * @param {string} text the condition
 * @returns {((val: unknown) => boolean) | null} null when the condition is not one of them
 */
function parseBadWhen(text) {
    const t = String(text ?? '').trim();
    if (t === 'false') {
        return v => v === false || v === 'false' || v === 0;
    }
    if (t === 'true') {
        return v => v === true || v === 'true' || v === 1;
    }
    const m = /^(>=|<=|>|<|==|!=)\s*(-?\d+(?:\.\d+)?)$/.exec(t);
    if (!m) {
        return null;
    }
    const n = Number(m[2]);
    const cmp = {
        '>=': x => x >= n,
        '<=': x => x <= n,
        '>': x => x > n,
        '<': x => x < n,
        '==': x => x === n,
        '!=': x => x !== n,
    }[m[1]];
    return v => {
        const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        return Number.isFinite(x) && cmp(x);
    };
}

/** `192.168.1.1:44818` → {host, port}; null when it is not one. */
function parseTarget(text) {
    const m = /^\s*([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})\s*$/.exec(String(text ?? ''));
    if (!m) {
        return null;
    }
    const port = Number(m[2]);
    return port >= 1 && port <= 65535 ? { host: m[1].replace(/^\[|\]$/g, ''), port } : null;
}

const int = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt);

/**
 * The health settings of an instance from `common.redundancy`, with the defaults filled in.
 * A critical instance moves the whole primary by default (§2.11a: no split primary).
 */
function healthConfig(redundancy) {
    const r = redundancy && typeof redundancy === 'object' ? redundancy : {};
    const h = r.health && typeof r.health === 'object' ? r.health : {};
    const v = r.verify && typeof r.verify === 'object' ? r.verify : {};
    const critical = r.critical === true;
    const badWhen = parseBadWhen(h.badWhen) ? String(h.badWhen).trim() : DEFAULTS.badWhen;
    const state = typeof h.state === 'string' && /^[\w.-]+$/.test(h.state) ? h.state : DEFAULTS.state;
    return {
        critical,
        onFailure: ON_FAILURE.has(r.onFailure) ? r.onFailure : critical ? 'host' : 'none',
        health: {
            state,
            badWhen,
            failures: int(h.failures, 1, 100, DEFAULTS.failures),
            detectMs: int(h.detectMs, 1000, 600_000, DEFAULTS.detectMs),
            recoverMs: int(h.recoverMs, 0, 3_600_000, DEFAULTS.recoverMs),
        },
        verify: {
            kind: VERIFY.has(v.kind) ? v.kind : 'probe',
            target: parseTarget(v.target) ? String(v.target).trim() : '',
        },
    };
}

/**
 * One instance's signal: healthy → suspect (bad) → failed after `failures` bad readings in a
 * row or `detectMs` of bad; a failed one is healthy again only after `recoverMs` of good
 * (hysteresis, so a flapping link does not count as recovered).
 */
class Tracker {
    constructor(health) {
        this.cfg = health;
        this.bad = parseBadWhen(health.badWhen);
        this.state = 'ok';
        this.badCount = 0;
        this.badSince = null;
        this.goodSince = null;
        this.lastBad = false;
        this.since = null;
    }

    /** A new reading: the signal state's value, or an instance that is not alive (bad). */
    feed(val, alive, now) {
        const bad = alive === false || this.bad(val);
        this.lastBad = bad;
        if (bad) {
            this.badCount++;
            this.badSince ??= now;
            this.goodSince = null;
        } else {
            this.badCount = 0;
            this.badSince = null;
            this.goodSince ??= now;
        }
        return this.tick(now);
    }

    /** The time-driven part: detect and recover also when no new value comes. */
    tick(now) {
        const before = this.state;
        if (this.lastBad) {
            const long = this.badSince !== null && now - this.badSince >= this.cfg.detectMs;
            if (this.state !== 'failed') {
                this.state = this.badCount >= this.cfg.failures || long ? 'failed' : 'suspect';
            }
        } else if (this.state === 'suspect') {
            this.state = 'ok';
        } else if (this.state === 'failed' && this.goodSince !== null && now - this.goodSince >= this.cfg.recoverMs) {
            this.state = 'ok';
        }
        if (this.state !== before) {
            this.since = now;
        }
        return this.state;
    }
}

/**
 * This server's health from its instances.
 *
 * @param {object} p
 * @param {Array<{id: string, cfg: object, state?: string, reach?: boolean | null}>} p.rows
 *   the managed instances: `state` from the tracker where the instance runs here, `reach`
 *   from this server's probe (null: not probed)
 * @param {boolean} p.primary this server is the primary
 * @param {Array<{t: number, host: string, instances: object}>} p.peers the other servers' reports
 * @param {number} p.now
 * @returns {{score: number, failing: string[], problems: Array<{id: string, why: string}>, instances: object}}
 *   `failing`: critical instances failing here that move the primary (the standby checked
 *   out); `problems`: failing ones that do not, and why
 */
function summarize({ rows, primary, peers, now }) {
    const fresh = peers.filter(p => p && now - Number(p.t) <= REPORT_STALE_MS);
    const instances = {};
    let critical = 0;
    let healthy = 0;
    const failing = [];
    const problems = [];
    for (const r of rows) {
        const failed = r.state === 'failed' || r.reach === false;
        instances[r.id] = { state: r.state ?? null, reach: r.reach ?? null };
        if (!r.cfg.critical) {
            continue;
        }
        critical++;
        if (!failed) {
            healthy++;
        }
        if (!primary || r.state !== 'failed') {
            continue;
        }
        if (r.cfg.onFailure !== 'host') {
            problems.push({ id: r.id, why: 'failing; on failure: alarm only' });
        } else if (r.cfg.verify.kind === 'none') {
            failing.push(r.id);
        } else if (!r.cfg.verify.target) {
            problems.push({ id: r.id, why: 'failing; no probe target is set, so the standby cannot be checked' });
        } else {
            const seen = fresh.map(p => p.instances && p.instances[r.id] && p.instances[r.id].reach);
            if (seen.includes(true)) {
                failing.push(r.id);
            } else if (seen.includes(false)) {
                problems.push({ id: r.id, why: 'field problem: the device is unreachable from every server' });
            } else {
                problems.push({ id: r.id, why: 'failing; the standby has not checked the device yet' });
            }
        }
    }
    const score = critical ? Math.round((100 * healthy) / critical) : 100;
    return { score, failing, problems, instances };
}

module.exports = { DEFAULTS, REPORT_STALE_MS, parseBadWhen, parseTarget, healthConfig, Tracker, summarize };
