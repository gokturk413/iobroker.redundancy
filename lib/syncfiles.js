'use strict';
// Sync of local files: what Redis does not hold (history files, sqlite, backups ...) under
// iobroker-data, by paths the operator lists. The source server lists and sends them, the
// target writes them under its own iobroker-data. iobroker.json (each server has its own)
// and the database files are never synced.

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;

const NEVER = [
    [/^iobroker\.json(\..*)?$/i, 'never synced: each server has its own'],
    [/^(objects|states)\.json(l)?(\..*)?$/i, 'never synced: a database file'],
    [/^files$/i, 'the files are in Redis already'],
];

/** Why a path may not be synced, or null. */
function refusal(p) {
    if (!p) {
        return 'empty';
    }
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
        return 'not inside iobroker-data';
    }
    if (p.split('/').some(s => s === '..' || s === '.' || s === '')) {
        return 'not a plain path';
    }
    const first = p.split('/')[0];
    const never = NEVER.find(([re]) => re.test(first));
    return never ? never[1] : null;
}

const clean = raw => String(raw == null ? '' : raw).trim().replace(/\\/g, '/');

/**
 * @param {unknown[]} list the paths the operator listed, relative to iobroker-data
 * @returns {{ok: string[], refused: {path: string, why: string}[]}}
 */
function checkPaths(list) {
    const ok = [];
    const refused = [];
    for (const raw of list) {
        const p = clean(raw);
        const why = refusal(p);
        if (why) {
            refused.push({ path: p, why });
        } else if (!ok.includes(p)) {
            ok.push(p);
        }
    }
    return { ok, refused };
}

/**
 * The files under the listed paths (symbolic links are skipped), sorted.
 *
 * @param {string} root iobroker-data of this server
 * @param {string[]} rels checked paths
 * @param {{maxFile?: number, maxTotal?: number}} [limits]
 */
function listFiles(root, rels, limits = {}) {
    const maxFile = limits.maxFile || MAX_FILE;
    const maxTotal = limits.maxTotal || MAX_TOTAL;
    const files = [];
    const walk = rel => {
        let st;
        try {
            st = fs.lstatSync(path.join(root, rel));
        } catch {
            return;
        }
        if (st.isDirectory()) {
            for (const name of fs.readdirSync(path.join(root, rel))) {
                walk(`${rel}/${name}`);
            }
        } else if (st.isFile()) {
            if (st.size > maxFile) {
                throw new Error(`${rel}: ${st.size} bytes, more than ${maxFile}`);
            }
            files.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        }
    };
    for (const rel of checkPaths(rels).ok) {
        walk(rel);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > maxTotal) {
        throw new Error(`${total} bytes, more than ${maxTotal}: list fewer paths`);
    }
    return { files, total };
}

/** What the target lacks, has in another size or older than the source. */
function diff(src, dst) {
    const there = new Map(dst.map(f => [f.path, f]));
    const out = [];
    for (const f of src) {
        const d = there.get(f.path);
        const why = !d ? 'missing' : d.size !== f.size ? 'other size' : d.mtimeMs < f.mtimeMs ? 'older' : null;
        if (why) {
            out.push({ path: f.path, size: f.size, why });
        }
    }
    return out;
}

/** Writes one synced file under root (via a temporary file), only to a plain path. */
function writeFile(root, rel, data) {
    const p = clean(rel);
    const why = refusal(p);
    if (why) {
        throw new Error(`${p}: ${why}`);
    }
    const target = path.resolve(root, p);
    if (!target.startsWith(path.resolve(root) + path.sep)) {
        throw new Error(`${p}: not inside iobroker-data`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.sync-tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
}

module.exports = { checkPaths, listFiles, diff, writeFile, MAX_FILE, MAX_TOTAL };
