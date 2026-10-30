'use strict';
// The instance objects (system.adapter.<name>.<n>) kept in memory. Reading them all is not cheap:
// one instance may carry megabytes in its native (rockwell-enip.1 held 145 071 tags = 22.8 MB on
// the lab), and the Redis view that returns them blocks Redis for everyone while it runs
// (28 ms per call). So: read them all once, then follow the object changes; read them all again
// only when it matters (a switch, after moves) and every few minutes in case an event was lost.

/** A full read at least this often, even without a reason. */
const FULL_EVERY_MS = 5 * 60_000;

const INSTANCE_ID = /^system\.adapter\.[^.]+\.\d+$/;

class InstanceCache {
    /**
     * @param {() => Promise<object[]>} loadAll reads every instance object
     * @param {() => number} [now]
     */
    constructor(loadAll, now = Date.now) {
        this.loadAll = loadAll;
        this.now = now;
        this.objs = new Map();
        this.loadedAt = 0;
        this.loading = null;
    }

    /** Reads them all (one read at a time; callers in between share it). */
    refresh() {
        if (!this.loading) {
            this.loading = this.loadAll()
                .then(list => {
                    this.objs = new Map(list.filter(o => o && INSTANCE_ID.test(o._id)).map(o => [o._id, o]));
                    this.loadedAt = this.now();
                })
                .finally(() => {
                    this.loading = null;
                });
        }
        return this.loading;
    }

    /** An object change event: an instance object written or deleted; anything else is ignored. */
    apply(id, obj) {
        if (!INSTANCE_ID.test(id)) {
            return;
        }
        if (obj && obj.type === 'instance') {
            this.objs.set(id, obj);
        } else if (!obj) {
            this.objs.delete(id);
        }
    }

    /** The instance objects; read them all first if never read or too long ago. */
    async list() {
        if (!this.loadedAt || this.now() - this.loadedAt >= FULL_EVERY_MS) {
            await this.refresh();
        }
        return [...this.objs.values()];
    }
}

module.exports = { InstanceCache, FULL_EVERY_MS };
