'use strict';
/*
 * catalog.js - mm-easy-entry: finds the seat and door interfaces in the head unit's SOME/IP catalog
 * (/etc/oap/someip/someip-interfaces.json: every service in the car with its wire ids and data types) and turns a
 * pick into what seatctl sends: service, instance, method / event, major version, payload.
 *
 * The catalog's shape, as BMW's generator and cauliflowermossgrape's tools read it:
 *   { interfaces: { "<name>": { serviceId, version?, fields: { <f>: { getter?: {id}, setter?: {id}, notifier?: {id,
 *     eventgroups?}, dataRef } }, methods: { <m>: { id, in?/inArgs?: [{ name, dataRef }] } }, events?: {...} } },
 *     datatypes: { <ref>: { type: struct|enum|typedef|array, members?, extends?, items?, dataRef?, baseType? } },
 *     instanceIDs: { "<name>": <id(s)> } }
 * Every accessor here is tolerant (other spellings, missing parts): what it cannot read it leaves out, and the
 * raw entry goes into the discovery file so it can be read by eye.
 *
 * Payload templates (hex, with placeholders): {slot} the memory slot as one byte, {slot:a,b,c} the a / b / c byte
 * for slot 1 / 2 / 3, {back} {up} the percent as one byte, {back16} {up16} as two bytes. Anything else is hex.
 */
const fs = require('fs');

const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const SIZES = { uint8: 1, int8: 1, boolean: 1, bool: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, float: 4,
    uint64: 8, int64: 8, double: 8 };
const MAX_CANDIDATES = 12;

function load(file) {
    try { return JSON.parse(fs.readFileSync(file || CATALOG, 'utf8')); } catch (e) { return null; }
}

const num = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) return Number(v.trim());
    return null;
};
const first = (...vs) => { for (const v of vs) if (v !== undefined && v !== null) return v; return undefined; };

function interfaces(db) {
    const i = db && db.interfaces;
    if (!i) return {};
    if (Array.isArray(i)) { const o = {}; i.forEach((x) => { if (x && x.name) o[x.name] = x; }); return o; }
    return i;
}
function serviceOf(i) { return num(first(i.serviceId, i.serviceID, i.service_id, i.service, i.id)); }
function majorOf(i) {
    const v = i.version;
    return num(first(v && v.major, i.majorVersion, i.major, typeof v === 'number' || typeof v === 'string' ? v : undefined)) || 1;
}
function instanceOf(db, name) {
    const m = db && (db.instanceIDs || db.instanceIds || db.instances);
    let v = m && m[name];
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === 'object') v = first(v.id, v.instanceId, Object.keys(v).map((k) => v[k])[0]);
    return num(v) || 1;
}
function methodsOf(i) {
    const m = i.methods || {};
    return Array.isArray(m) ? m.reduce((o, x) => { if (x && x.name) o[x.name] = x; return o; }, {}) : m;
}
function argsOf(m) {
    const a = first(m.in, m.inArgs, m.inArguments, m.inParameters, m.arguments, m.params) || [];
    return (Array.isArray(a) ? a : Object.keys(a).map((k) => Object.assign({ name: k }, a[k])))
        .map((x) => ({ name: x.name, dataRef: first(x.dataRef, x.type, x.datatype) }));
}
function fieldsOf(i) { return i.fields || i.attributes || {}; }
function notifierOf(f) {
    const n = f.notifier || f.event || f.broadcast;
    if (!n) return null;
    const groups = first(n.eventgroups, n.eventGroups, n.eventgroup, n.eventGroup, n.groups);
    const g = Array.isArray(groups) ? groups[0] : groups;
    return { id: num(first(n.id, n.eventId, n.event)), group: num(g && typeof g === 'object' ? first(g.id, g.eventgroupId) : g) || 1 };
}

/* ---- data types: size, members with offsets, enum items ---- */
function dtype(db, ref) { return db && db.datatypes && db.datatypes[ref]; }
function baseName(ref) { return String(ref || '').replace(/^.*[.:]/, '').toLowerCase(); }
/* fixed byte size of ref, or null (strings, arrays, unknown) */
function sizeOf(db, ref, depth) {
    if ((depth || 0) > 8) return null;
    const d = dtype(db, ref);
    if (!d) return SIZES[baseName(ref)] || null;
    if (d.type === 'enum') return SIZES[baseName(first(d.baseType, d.backingType))] || 1;
    if (d.type === 'typedef') return sizeOf(db, first(d.dataRef, d.baseType), (depth || 0) + 1);
    if (d.type === 'struct') {
        let n = 0;
        for (const m of members(db, ref)) { const s = sizeOf(db, m.dataRef, (depth || 0) + 1); if (s === null) return null; n += s; }
        return n;
    }
    return null;
}
function members(db, ref) {
    let d = dtype(db, ref), out = [];
    for (let k = 0; d && k < 8; k++) { out = (d.members || []).concat(out); d = d.extends ? dtype(db, d.extends) : null; }
    return out.map((m) => ({ name: m.name, dataRef: first(m.dataRef, m.type) }));
}
function enumItems(db, ref) {
    let d = dtype(db, ref);
    for (let k = 0; d && d.type === 'typedef' && k < 8; k++) d = dtype(db, first(d.dataRef, d.baseType));
    if (!d || d.type !== 'enum' || !d.items) return null;
    const it = d.items;
    if (Array.isArray(it)) return it.map((x) => ({ name: x.name, value: num(x.value) }));
    return Object.keys(it).map((k) => ({ name: k, value: num(typeof it[k] === 'object' ? it[k].value : it[k]) }));
}
/* the leaves of a struct with byte offsets while every size before them is fixed: [{ path, offset, size, dataRef }] */
function leaves(db, ref, prefix, at, out, depth) {
    out = out || [];
    const d = dtype(db, ref);
    if (d && d.type === 'struct' && (depth || 0) < 4) {
        let o = at;
        for (const m of members(db, ref)) {
            const s = sizeOf(db, m.dataRef);
            leaves(db, m.dataRef, prefix ? `${prefix}.${m.name}` : m.name, o, out, (depth || 0) + 1);
            if (s === null || o === null) o = null; else o += s;
        }
        return out;
    }
    out.push({ path: prefix || '', offset: at, size: sizeOf(db, ref), dataRef: ref });
    return out;
}

/* ---- payload templates ---- */
const hx = (v, bytes) => (v >>> 0).toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);

/* a template for ref: zeros, with {slot...} / driver picks where an argument's name or enum says so */
function template(db, ref, name, depth) {
    if ((depth || 0) > 8) return '';
    const d = dtype(db, ref), label = `${name || ''} ${ref || ''}`;
    if (d && d.type === 'struct') return members(db, ref).map((m) => template(db, m.dataRef, m.name, (depth || 0) + 1)).join('');
    if (d && d.type === 'typedef' && !enumItems(db, ref)) return template(db, first(d.dataRef, d.baseType), name, (depth || 0) + 1);
    const items = enumItems(db, ref);
    const size = sizeOf(db, ref);
    if (size === null) return '00000000';   // a string / array: empty, behind its u32 length
    if (items && size === 1) {
        if (/memory|memo|speicher|slot|position|button|taste|recall|abruf/i.test(label)) {
            const per = [1, 2, 3].map((n) => items.find((x) => new RegExp(`(^|[^0-9])${n}$`).test(x.name)));
            if (per.every(Boolean)) return `{slot:${per.map((x) => x.value).join(',')}}`;
        }
        const drv = items.find((x) => /driver|fahrer|^fa$|_fa$|^dr$|_dr$|links|left/i.test(x.name));
        if (drv && /seat|sitz|side|zone|row|position|occupant|place/i.test(label)) return hx(drv.value, 1);
        return hx(items[0].value || 0, 1);
    }
    if (size === 1 && /memory|memo|speicher|slot|button|taste/i.test(label)) return '{slot}';
    if (/back|rueck|längs|laengs|longitud/i.test(label)) return size === 1 ? '{back}' : size === 2 ? '{back16}' : '00'.repeat(size);
    if (/height|hoehe|höhe|\bup\b/i.test(label)) return size === 1 ? '{up}' : size === 2 ? '{up16}' : '00'.repeat(size);
    if (size === 1 && /zone|seat|sitz/i.test(label)) return '01';      // zone 1: the driver, as Climate numbers it
    return '00'.repeat(size);
}

/* template + values -> hex; throws on a bad template */
function fill(tpl, v) {
    const vals = v || {};
    const out = String(tpl || '').replace(/\{(\w+)(?::([0-9a-fx,]+))?\}/gi, (m, key, list) => {
        if (key === 'slot' && list) {
            const pick = list.split(',')[(vals.slot || 1) - 1];
            if (pick === undefined) throw new Error(`no value for slot ${vals.slot} in ${m}`);
            return hx(Number(pick), 1);
        }
        if (key === 'slot') return hx(vals.slot || 1, 1);
        if (key === 'back' || key === 'up') return hx(Math.round(vals[key] || 0), 1);
        if (key === 'back16' || key === 'up16') return hx(Math.round(vals[key.slice(0, -2)] || 0), 2);
        throw new Error(`unknown placeholder ${m}`);
    }).replace(/\s+/g, '').toLowerCase();
    if (!/^([0-9a-f]{2})*$/.test(out)) throw new Error(`not hex: ${out}`);
    return out;
}

/* ---- search ---- */
const SEAT = /seat|sitz/i;
const MEMORY = /memory|memo|speicher|recall|abruf|position.?call|call.?position/i;
const MOVE = /position|longitud|laengs|längs|height|hoehe|höhe|move|adjust|verstell|easy.?entry|einstieg|comfort.?entry/i;
const DOOR = /door|tuer|tür/i;
const DRIVER = /driver|fahrer|(^|[^a-z])(fa|dr|fl|vl)([^a-z]|$)|front.?left|vorne.?links/i;
const OPEN = /open|offen|geoeffnet|geöffnet|auf$/i;

function search(db) {
    const res = { memory: [], position: [], door: [], seatAll: [], doorAll: [] };
    const ifs = interfaces(db);
    Object.keys(ifs).forEach((name) => {
        const i = ifs[name], svc = serviceOf(i);
        if (svc === null) return;
        const base = { iface: name, svc, inst: instanceOf(db, name), major: majorOf(i) };
        const ms = methodsOf(i);
        Object.keys(ms).forEach((mn) => {
            const m = ms[mn], id = num(first(m.id, m.methodId));
            if (id === null) return;
            const label = `${name}.${mn}`, args = argsOf(m);
            const cand = Object.assign({}, base, { kind: 'method', name: mn, method: id, args: args.map((a) => `${a.name}:${a.dataRef}`),
                payload: args.map((a) => template(db, a.dataRef, a.name)).join(''), reply: !(m.fireAndForget || m.fireandforget) });
            if (SEAT.test(label)) res.seatAll.push(cand);
            if (SEAT.test(label) && MEMORY.test(mn)) res.memory.push(Object.assign({ score: (/recall|abruf|call/i.test(mn) ? 3 : 1) + (/request|set|control|steuer/i.test(mn) ? 1 : 0) }, cand));
            else if (SEAT.test(label) && MOVE.test(mn)) res.position.push(Object.assign({ score: (/request|set|control|steuer/i.test(mn) ? 2 : 1) + (/easy|einstieg|entry/i.test(mn) ? 2 : 0) }, cand));
        });
        const fs_ = fieldsOf(i);
        Object.keys(fs_).forEach((fn) => {
            const f = fs_[fn], n = notifierOf(f);
            const label = `${name}.${fn}`;
            if (!DOOR.test(label)) return;
            res.doorAll.push(Object.assign({}, base, { kind: 'field', name: fn, event: n && n.id, group: n && n.group }));
            if (!n || n.id === null) return;
            leaves(db, f.dataRef, '', 0).forEach((lf) => {
                const full = `${fn}.${lf.path}`;
                if (lf.offset === null || lf.size !== 1 || !(DOOR.test(full) || DOOR.test(name))) return;
                const items = enumItems(db, lf.dataRef) || [];
                const open = items.filter((x) => OPEN.test(x.name) && !/not|nicht|un/i.test(x.name)).map((x) => x.value);
                const score = (DRIVER.test(full) ? 3 : 0) + (open.length ? 2 : 0) + (/status/i.test(fn) ? 1 : 0);
                res.door.push(Object.assign({}, base, { kind: 'field', name: lf.path ? full : fn, event: n.id, group: n.group,
                    byte: lf.offset, open: open.length ? open : [1], items: items.map((x) => `${x.name}=${x.value}`), score }));
            });
        });
    });
    ['memory', 'position', 'door'].forEach((k) => { res[k].sort((a, b) => b.score - a.score); res[k] = res[k].slice(0, MAX_CANDIDATES); });
    return res;
}

/* the raw catalog entries of the interfaces named in found (for the discovery file) */
function raw(db, found) {
    const ifs = interfaces(db), out = {};
    found.forEach((c) => { if (!out[c.iface]) out[c.iface] = ifs[c.iface]; });
    return out;
}

/* a candidate as one short line for the app */
const short = (c) => `${c.iface.replace(/^de\.bmw\.[a-z]+\./, '')}.${c.name}`.slice(0, 60);

function test() {
    const assert = require('assert');
    const db = {
        interfaces: {
            'de.bmw.infotainment.vehicle.SeatComfort': { serviceId: '0xB5AA', version: { major: 1 },
                methods: { requestSeatMemoryRecall: { id: 12, in: [{ name: 'seat', dataRef: 'SeatSel' }, { name: 'memoryPosition', dataRef: 'MemPos' }] },
                    requestSeatPosition: { id: 14, in: [{ name: 'zone', dataRef: 'UInt8' }, { name: 'longitudinal', dataRef: 'UInt8' }, { name: 'height', dataRef: 'UInt16' }] },
                    getVersion: { id: 1 } },
                fields: {} },
            'de.bmw.infotainment.vehicle.Body': { serviceId: 45600,
                fields: { statusDoors: { notifier: { id: '0x8005', eventgroups: [3] }, dataRef: 'Doors' }, other: { dataRef: 'UInt8' } } },
        },
        datatypes: {
            SeatSel: { type: 'enum', items: { UNKNOWN: 0, DRIVER: 1, PASSENGER: 2 } },
            MemPos: { type: 'enum', items: { NONE: 0, MEMORY_1: 1, MEMORY_2: 2, MEMORY_3: 3 } },
            DoorState: { type: 'enum', items: { CLOSED: 0, OPEN: 1, INVALID: 15 } },
            Doors: { type: 'struct', members: [{ name: 'counter', dataRef: 'UInt16' }, { name: 'doorDriver', dataRef: 'DoorState' },
                { name: 'doorPassenger', dataRef: 'DoorState' }] },
        },
        instanceIDs: { 'de.bmw.infotainment.vehicle.Body': ['2'] },
    };
    const r = search(db);
    assert.strictEqual(r.memory[0].name, 'requestSeatMemoryRecall');
    assert.strictEqual(r.memory[0].svc, 0xb5aa);
    assert.strictEqual(r.memory[0].payload, '01{slot:1,2,3}');
    assert.strictEqual(fill(r.memory[0].payload, { slot: 2 }), '0102');
    assert.strictEqual(r.position[0].payload, '01{back}{up16}');
    assert.strictEqual(fill(r.position[0].payload, { back: 100, up: 60 }), '0164003c');
    assert.strictEqual(r.door[0].name, 'statusDoors.doorDriver');
    assert.deepStrictEqual([r.door[0].byte, r.door[0].event, r.door[0].group, r.door[0].inst, r.door[0].open], [2, 0x8005, 3, 2, [1]]);
    assert.strictEqual(r.doorAll.length, 1);
    assert.throws(() => fill('{nope}'));
    assert.throws(() => fill('0g'));
    assert.strictEqual(fill('04 {slot} 01', { slot: 1 }), '040101');
    assert.strictEqual(short(r.memory[0]), 'vehicle.SeatComfort.requestSeatMemoryRecall');
    assert.deepStrictEqual(Object.keys(raw(db, r.memory)), ['de.bmw.infotainment.vehicle.SeatComfort']);
    assert.strictEqual(load('/nonexistent'), null);
    console.log('catalog self-check ok');
}

module.exports = { CATALOG, load, search, fill, raw, short, test };
if (require.main === module) test();
