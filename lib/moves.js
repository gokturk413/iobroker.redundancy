'use strict';
// Cold instances follow the primary (RFC-003 §2.1b; H1e). Which instance moves and how is
// decided by the native engine (planMoves); this file only carries the steps out.

/** How long a move waits for the old host to stop its copy. */
const WAIT_MS = 10_000;
/** The old host's stop writes sigKill and kills the process 1 s later: give it this long. */
const MIN_WAIT_MS = 3000;
const POLL_MS = 250;

/**
 * @param {Array<{id: string, from: string, stopFirst: boolean, enableAfter: boolean}>} moves
 * @param {string} me ioBroker host of this adapter instance
 * @param {object} io object and state access (see main.js), injectable for the tests
 * @param {{waitMs?: number, minWaitMs?: number, pollMs?: number}} [opts]
 */
async function runMoves(moves, me, io, opts = {}) {
    const waitMs = opts.waitMs ?? WAIT_MS;
    const minWaitMs = opts.minWaitMs ?? MIN_WAIT_MS;
    const pollMs = opts.pollMs ?? POLL_MS;
    const results = [];
    for (const m of moves) {
        const r = { id: m.id, from: m.from, ok: false, waitedMs: 0, timedOut: false };
        try {
            if (m.stopFirst) {
                // the old host stops its copy (and writes sigKill = -1) before the new one starts
                await io.extend(m.id, { enabled: false, redundancy: { movingTo: me } });
                // alive = false is not "stopped": a copy in a restart reads false while the
                // old host is still about to stop it, so it always gets minWaitMs
                const t0 = io.now();
                for (;;) {
                    const alive = await io.isAlive(m.id);
                    const waited = io.now() - t0;
                    if (!alive && waited >= minWaitMs) {
                        break;
                    }
                    if (waited >= waitMs) {
                        r.timedOut = alive;
                        break;
                    }
                    await io.sleep(pollMs);
                }
                r.waitedMs = io.now() - t0;
            }
            // js-controller refuses to start it while alive is true or a host's sigKill names
            // another process
            await io.clearSigKill(m.id);
            await io.setNotAlive(m.id);
            const common = { host: me, redundancy: { movingTo: null } };
            if (m.enableAfter) {
                common.enabled = true;
            }
            await io.extend(m.id, common);
            r.ok = true;
        } catch (e) {
            r.error = e.message;
        }
        results.push(r);
    }
    return results;
}

/**
 * Moves every cold instance of the other pair host here while this host is the primary.
 *
 * @param {{status: object|null, me: string, addon: object, io: object, opts?: object}} p
 */
async function reconcile({ status, me, addon, io, opts }) {
    if (!status || status.role !== 'primary') {
        return { moves: [], skipped: [] };
    }
    const input = {
        me,
        pair: await io.getPair(),
        // the watchdog: no beats and the witness does not see the peer either
        oldHostGone: status.peer === 'Lost',
        instances: await io.getInstances(),
        // adapters installed here: one that is missing cannot start here, so it does not move
        installed: await io.getInstalled(),
    };
    const plan = JSON.parse(addon.planMoves(JSON.stringify(input)));
    const moves = plan.moves.length ? await runMoves(plan.moves, me, io, opts) : [];
    for (const r of moves) {
        const m = plan.moves.find(x => x.id === r.id);
        if (m && m.warning) {
            r.warning = m.warning;
        }
    }
    return { moves, skipped: plan.skipped };
}

const MODES = new Set(['cold', 'hot', 'none']);

/**
 * `system.adapter.<id>` → what planMoves reads. An unknown mode counts as none: one bad
 * value must not stop the plan for every instance.
 *
 * @param {{_id: string, common?: object}} obj instance object
 */
function instanceFromObject(obj) {
    const c = obj.common || {};
    if (typeof c.host !== 'string' || !c.host) {
        return null;
    }
    const r = c.redundancy || {};
    return {
        id: obj._id.replace(/^system\.adapter\./, ''),
        host: c.host,
        enabled: c.enabled === true,
        // until the hosts can run one instance on every server (H3), hot follows the primary like cold
        mode: r.mode === 'hot' ? 'cold' : MODES.has(r.mode) ? r.mode : 'none',
        movingTo: typeof r.movingTo === 'string' ? r.movingTo : null,
        version: typeof c.version === 'string' ? c.version : null,
    };
}

/**
 * The redundant pair: every host that runs a redundancy instance.
 *
 * @param {Array<{_id: string, common?: object}>} objs instance objects
 */
function pairHosts(objs) {
    const hosts = objs
        .filter(o => /^system\.adapter\.redundancy\.\d+$/.test(o._id) && o.common?.host)
        .map(o => o.common.host);
    return [...new Set(hosts)].sort();
}

module.exports = { runMoves, reconcile, instanceFromObject, pairHosts };
