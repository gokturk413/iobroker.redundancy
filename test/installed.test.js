'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installedAdapters, differences } = require('../lib/installed');

function nodeModules(pkgs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
    for (const [name, pkg] of Object.entries(pkgs)) {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        if (pkg !== null) {
            fs.writeFileSync(path.join(dir, name, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
        }
    }
    return dir;
}

test('the adapters of a host are its iobroker.* packages with their versions', () => {
    const dir = nodeModules({
        'iobroker.modbus': { name: 'iobroker.modbus', version: '6.3.2' },
        'iobroker.rockwell-enip': { name: 'iobroker.rockwell-enip', version: '0.2.1' },
        'iobroker.js-controller': { name: 'iobroker.js-controller', version: '7.2.2' },
        'iobroker.broken': '{not json',
        'iobroker.empty': null,
        lodash: { name: 'lodash', version: '4.17.21' },
    });
    assert.deepStrictEqual(installedAdapters(dir), { modbus: '6.3.2', 'rockwell-enip': '0.2.1' });
    assert.deepStrictEqual(installedAdapters(path.join(dir, 'missing')), {}, 'no folder: nothing');
});

test('what one host has that another lacks or has in another version', () => {
    assert.deepStrictEqual(
        differences({ modbus: '6.3.2', 'rockwell-enip': '0.2.1', mqtt: '7.0.0' }, { modbus: '6.3.2', 'rockwell-enip': '0.2.0' }),
        { missing: ['mqtt'], other: [{ adapter: 'rockwell-enip', here: '0.2.1', there: '0.2.0' }] },
    );
});
