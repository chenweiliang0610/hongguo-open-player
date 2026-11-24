// SPDX-License-Identifier: GPL-3.0-only
// v04.10.03 signing vectors from N3urda/hongguoTV (GPL-3.0-only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
    hashF13V5, AesV3V5, branchV5, signPlaybackV5, encodeValues,
} = require('../../src/server/native/v5-sign');

const hex = value => Buffer.from(value, 'hex');
const vectorsDir = path.join(__dirname, '..', 'fixtures', 'v5');

test('v5 AesV3 matches official carrier vectors byte-for-byte', () => {
    if (!fs.existsSync(path.join(vectorsDir, 'signing-v5-carrier.json'))) return;
    const rows = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'signing-v5-carrier.json'), 'utf8'));
    assert.equal(rows.length, 4);
    for (const [i, row] of rows.entries()) {
        const actual = new AesV3V5(hex(row.key), row.ts).encrypt(hex(row.source), hex(row.iv)).toString('hex');
        assert.equal(actual, row.encrypted, `carrier variant ${i}`);
    }
});

test('v5 hashF13 matches independent SDK digest vectors across timestamp rotations', () => {
    if (!fs.existsSync(path.join(vectorsDir, 'signing-v5-f13.json'))) return;
    const rows = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'signing-v5-f13.json'), 'utf8'));
    assert.equal(rows.length, 32);
    for (const [i, row] of rows.entries()) {
        const result = hashF13V5(hex(row.query), hex(row.body), row.ts);
        assert.equal(result.length, 20);
        assert.equal(result.subarray(0, 16).toString('hex'), row.digest, `timestamp class ${i}`);
        assert.equal(result[16] & 0x24, 0x24, 'checksum bit 5 is set for v5');
    }
});

test('v5 playback signing searches only _rticket and binds compressed body and identity', () => {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
    const values = {
        aid: '8662', app_name: 'novelread', version_code: '74532', version_name: '7.4.5.32',
        update_version_code: '74532', manifest_version_code: '74532', os: 'android', ssmix: 'a',
        channel: 'update_64', device_platform: 'android', device_type: '25053RT47C',
        device_brand: 'Redmi', os_version: '16', os_api: '36', ac: 'wifi', language: 'zh',
        host_abi: 'arm64-v8a', iid: '456', cdid: 'synthetic-cdid', device_id: '123',
    };
    const now = 1800000000000;
    const ts = Math.floor(now / 1000);
    const base = 'https://example.test/model';
    const signed = signPlaybackV5(base, values, body, now);
    const url = new URL(signed.url);
    assert.equal(url.searchParams.has('ts'), false);
    for (const [key, value] of Object.entries(values)) {
        if (key === '_rticket') continue;
        assert.equal(url.searchParams.get(key), value, `query preserves ${key}`);
    }
    assert.equal(branchV5(url.search.slice(1), body, ts), 0);
    assert.equal(signed.headers['x-khronos'], String(ts));
    assert.equal(signed.headers['x-ss-stub'], createHash('md5').update(body).digest('hex').toUpperCase());
    assert.deepEqual(Object.keys(signed.headers).sort(),
        ['Content-Type', 'x-helios', 'x-khronos', 'x-medusa', 'x-ss-stub']);
    assert.ok(signed.headers['x-medusa'].length > 100);
    assert.ok(signed.headers['x-helios'].length > 20);
});

test('v5 playback signing matches verified field-21=312 wire contract byte-for-byte', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(vectorsDir, 'signing-v5-playback-312.json'), 'utf8'));
    const identity = {};
    for (const key of fixture.queryOrder) {
        identity[key] = fixture.identity[key];
    }
    const body = Buffer.from(fixture.body, 'base64');
    const signed = signPlaybackV5('https://example.test/model', identity, body, 1800000000000, {
        random: () => 0.5,
        nonce: 'synthetic',
        started: 1800000000000,
    });
    assert.equal(signed.url, fixture.url);
    assert.deepEqual(Object.keys(signed.headers).sort(), Object.keys(fixture.headers).sort());
    for (const [key, value] of Object.entries(fixture.headers)) {
        assert.equal(signed.headers[key], value, `header ${key} matches fixture`);
    }
});

test('v5 empty-body GET signing uses MD5 of empty bytes and omits POST headers', () => {
    const values = {
        aid: '8662', app_name: 'novelread', version_code: '74532', version_name: '7.4.5.32',
        channel: 'update_64', device_platform: 'android', device_type: '25053RT47C',
        os_version: '16', update_version_code: '74532',
        iid: '456', cdid: 'synthetic-cdid', device_id: '123',
    };
    const now = 1800000000000;
    const ts = Math.floor(now / 1000);
    const signed = signPlaybackV5('https://example.test/tab', values, Buffer.alloc(0), now);
    const url = new URL(signed.url);
    assert.equal(branchV5(url.search.slice(1), Buffer.alloc(0), ts), 0);
    assert.deepEqual(Object.keys(signed.headers).sort(), ['x-helios', 'x-khronos', 'x-medusa']);
});

test('v5 signing rejects invalid branch inputs deterministically', () => {
    const query = createHash('sha256').update('bad').digest().subarray(0, 32);
    const body = createHash('md5').update('body').digest();
    // A wrong ts almost never lands on branch 12; hashF13V5 must refuse it.
    assert.throws(() => hashF13V5(query, body, 1800000000), /v5 hash branch unsupported/);
    assert.equal(typeof encodeValues({ a: '7.4.5.32', b: '~x y' }), 'string');
});
