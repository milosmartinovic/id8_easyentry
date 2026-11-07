'use strict';
/*
 * easyentry.js - mm-easy-entry: easy entry / exit for the driver's seat on iDrive 8 (BMW G87 M2 and others),
 * root service, Node 8.
 *
 *   engine off, then the driver's door opens  -> the seat goes back and up (position mode), or to its memory 2
 *   engine start                              -> the seat goes to its memory 1
 * When to move: logic.js. SOME/IP: someip.js over seatctl (native/seatctl). Which services move the seat and report
 * the door: picked in the app from what catalog.js finds in the head unit's catalog, kept in the settings.
 *
 * Files: /var/opt/mm-easy-entry/settings.json (kept over updates), discovery.json (what the catalog search found,
 * with the raw catalog entries), log.txt. The app talks to it over /run/mm-easy-entry/ctl.sock (JSON lines):
 *   -> { op: 'get' } | { op: 'set', settings } | { op: 'pick', kind: memory|position|door, i } | { op: 'clear', kind }
 *      | { op: 'test', what: exit|entry|memory1|memory2 } | { op: 'discover' } | { op: 'export' }
 *   <- { state } after every change; { reply: { op, ok, text } } to a test / export
 *
 *   node easyentry.js           the service
 *   node easyentry.js --test    the self-checks (no car needed)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Logic, DEFAULTS } = require('./logic');
const catalog = require('./catalog');
const { Bus } = require('./someip');

const VERSION = '0.1.0';
const DIR = process.env.EASY_ENTRY_DATA || '/var/opt/mm-easy-entry';
const SETTINGS = path.join(DIR, 'settings.json');
const DISCOVERY = path.join(DIR, 'discovery.json');
const LOG = path.join(DIR, 'log.txt');
const CTL = process.env.EASY_ENTRY_CTL || '/run/mm-easy-entry/ctl.sock';
const SEATCTL = process.env.EASY_ENTRY_SEATCTL || path.join(__dirname, 'seatctl');
const CATALOG = process.env.EASY_ENTRY_CATALOG || catalog.CATALOG;
const MEDIA = '/media';
const TICK_MS = 250;
// VehicleCondition 0x1531 inst 1 v1, vehicleConditionNoCrc 0x8002 in event group 2, byte 5 statusConditionVehicle
// (as iDrive 8's Overlays tool reads it on a G82); a catalog of another layout can override it in the settings
const CONDITION = { svc: 0x1531, inst: 1, major: 1, group: 2, event: 0x8002, byte: 5 };

/* ---- log ---- */
function log(m) {
    const line = `${new Date().toISOString()} ${m}`;
    console.log(line);
    try { if (fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, `${LOG}.1`); } catch (e) { /* none yet */ }
    try { fs.appendFileSync(LOG, `${line}\n`); } catch (e) { /* no folder */ }
}

/* ---- settings ---- */
const SEAT_KINDS = ['memory', 'position', 'door'];
function loadSettings(file) {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* defaults */ }
    const out = Object.assign({}, DEFAULTS, s);
    out.seat = Object.assign({ memory: null, position: null, door: null }, s.seat || {});
    out.condition = Object.assign({}, CONDITION, s.condition || {});
    return out;
}
function saveSettings(file, s) {
    try {
        fs.mkdirSync(path.dirname(file));
    } catch (e) { /* there */ }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, file);
}
/* what the app may change, checked */
function cleanSettings(set) {
    const out = {};
    if (typeof set.enabled === 'boolean') out.enabled = set.enabled;
    if (set.exitMode === 'position' || set.exitMode === 'memory2') out.exitMode = set.exitMode;
    ['back', 'up'].forEach((k) => { if (typeof set[k] === 'number' && set[k] >= 0 && set[k] <= 100) out[k] = Math.round(set[k]); });
    if (set.trigger === 'door' || set.trigger === 'engineoff') out.trigger = set.trigger;
    if (typeof set.entryOnStart === 'boolean') out.entryOnStart = set.entryOnStart;
    if (typeof set.entryOnlyAfterExit === 'boolean') out.entryOnlyAfterExit = set.entryOnlyAfterExit;
    if (typeof set.exitDelayMs === 'number' && set.exitDelayMs >= 0 && set.exitDelayMs <= 30000) out.exitDelayMs = set.exitDelayMs;
    return out;
}

/* a door event's payload -> true open / false closed / null unreadable */
function doorOpen(door, hex) {
    const at = door.byte * 2;
    if (!hex || hex.length < at + 2) return null;
    let v = parseInt(hex.slice(at, at + 2), 16);
    if (door.mask) v &= Number(door.mask);
    return (door.open || [1]).indexOf(v) >= 0;
}
/* a condition event's payload -> statusConditionVehicle or null */
function conditionOf(c, hex) {
    const at = c.byte * 2;
    return hex && hex.length >= at + 2 ? parseInt(hex.slice(at, at + 2), 16) : null;
}

/* ---- the service ---- */
class Service {
    constructor(opts) {
        this.o = opts;
        this.settings = loadSettings(opts.settings);
        this.logic = new Logic(this.settings, Date.now() - this._uptimeMs());
        this.found = null;              // catalog.search() result, null: no catalog
        this.catalogInfo = { file: opts.catalog, present: false };
        this.last = null;               // { kind, at, ok, text } the last seat move
        this.busy = false;              // a seat move being sent
        this.clients = new Set();
        this.bus = new Bus(opts.seatctl, log);
    }

    _uptimeMs() {
        // a start of the service soon after boot counts the boot as its start (BOOT_GRACE in logic.js)
        try { return parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000; } catch (e) { return 0; }
    }

    start() {
        log(`mm-easy-entry ${VERSION} starting (seatctl ${this.o.seatctl})`);
        this.discover();
        this.bus.on('event', (svc, ev, hex) => this._event(svc, ev, hex));
        this.bus.on('up', () => this.push());
        this.bus.on('down', () => this.push());
        const c = this.settings.condition;
        this.bus.subscribe({ svc: c.svc, inst: c.inst, major: c.major, group: c.group, events: [c.event] });
        this._subscribeDoor();
        this.bus.start();
        this.timer = setInterval(() => this._run(this.logic.tick(Date.now())), TICK_MS);
        this._listen();
    }

    _subscribeDoor() {
        const d = this.settings.seat.door;
        if (d && d.event) this.bus.subscribe({ svc: d.svc, inst: d.inst, major: d.major, group: d.group || 1, events: [d.event] });
    }

    _event(svc, ev, hex) {
        const c = this.settings.condition, d = this.settings.seat.door;
        if (svc === c.svc && ev === c.event) {
            const n = conditionOf(c, hex);
            if (n !== this.logic.cond) log(`vehicle condition ${n}`);
            this._run(this.logic.onCondition(n, Date.now()));
            this.push();
        }
        if (d && svc === d.svc && ev === d.event) {
            const open = doorOpen(d, hex);
            if (open !== this.logic.door) log(`driver door ${open === null ? 'unreadable' : open ? 'open' : 'closed'}`);
            this._run(this.logic.onDoor(open, Date.now()));
            this.push();
        }
    }

    _run(actions) {
        actions.forEach((a) => {
            if (a.kind === 'entry') this.memory(1, 'entry');
            if (a.kind === 'exit') this.exit(a);
        });
    }

    /* the seat to memory slot */
    memory(slot, kind) {
        const m = this.settings.seat.memory;
        if (!m) return this._done(kind, false, `memory ${slot}: seat memory not set up (Discovery)`);
        let hex;
        try { hex = catalog.fill(m.payload, { slot }); } catch (e) { return this._done(kind, false, `memory ${slot}: ${e.message}`); }
        return this._send(kind, m, hex, `memory ${slot}`);
    }

    /* back and up, or memory 2 */
    exit(a) {
        const p = this.settings.seat.position;
        if (a.mode === 'position' && p) {
            let hex;
            try { hex = catalog.fill(p.payload, { back: a.back, up: a.up }); } catch (e) { hex = null; log(`position payload: ${e.message}`); }
            if (hex !== null) {
                return this._send('exit', p, hex, `back ${a.back} % / up ${a.up} %`).then((ok) => (ok ? ok : this.memory(2, 'exit')));
            }
        }
        if (a.mode === 'position' && !p) log('exit: no seat position control set up, memory 2 instead');
        return this.memory(2, 'exit');
    }

    _send(kind, m, hex, what) {
        this.busy = true;
        this.push();
        log(`${kind}: ${what} -> ${catalog.short(m)} 0x${m.svc.toString(16)}.${m.method} ${hex}`);
        return this.bus.call(m, hex).then((r) => {
            this.busy = false;
            return this._done(kind, r.ok, `${what}: ${r.ok ? 'sent' : r.why}${r.hex ? ` (${r.hex.slice(0, 32)})` : ''}`);
        });
    }

    _done(kind, ok, text) {
        this.last = { kind, at: Date.now(), ok, text };
        log(`${kind} ${ok ? 'ok' : 'failed'}: ${text}`);
        this.push();
        return Promise.resolve(ok);
    }

    /* ---- discovery ---- */
    discover() {
        const db = catalog.load(this.o.catalog);
        this.catalogInfo = { file: this.o.catalog, present: !!db, interfaces: db && db.interfaces ? Object.keys(db.interfaces).length : 0 };
        if (!db) { this.found = null; log(`no SOME/IP catalog at ${this.o.catalog}`); return; }
        this.found = catalog.search(db);
        const f = this.found;
        log(`catalog: ${this.catalogInfo.interfaces} interfaces; seat memory ${f.memory.length}, seat position ${f.position.length}, ` +
            `door ${f.door.length} candidates; ${f.seatAll.length} seat methods`);
        try {
            fs.writeFileSync(this.o.discovery, JSON.stringify({ at: new Date().toISOString(), version: VERSION, found: f,
                raw: catalog.raw(db, f.memory.concat(f.position, f.seatAll.slice(0, 40), f.door.slice(0, 6))) }, null, 1));
        } catch (e) { log(`discovery file: ${e.message}`); }
    }

    /* the discovery files and the log onto the first USB stick that takes them */
    exportUsb() {
        let sticks = [];
        try { sticks = fs.readdirSync(MEDIA).map((n) => path.join(MEDIA, n)).filter((p) => fs.statSync(p).isDirectory()); } catch (e) { /* none */ }
        const files = [[this.o.discovery, 'mm-easy-entry-discovery.json'], [LOG, 'mm-easy-entry-log.txt'], [this.o.catalog, 'someip-interfaces.json']];
        for (const s of sticks) {
            try {
                files.forEach(([from, to]) => { if (fs.existsSync(from)) fs.writeFileSync(path.join(s, to), fs.readFileSync(from)); });
                return { ok: true, text: `Saved to USB (${path.basename(s)})` };
            } catch (e) { log(`export to ${s}: ${e.message}`); }
        }
        return { ok: false, text: sticks.length ? 'USB stick is read-only' : 'No USB stick found' };
    }

    /* ---- control socket ---- */
    _listen() {
        try { fs.unlinkSync(this.o.ctl); } catch (e) { /* none */ }
        this.server = net.createServer((sock) => {
            this.clients.add(sock);
            let buf = '';
            sock.setEncoding('utf8');
            sock.on('data', (d) => {
                buf += d;
                let n;
                while ((n = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, n);
                    buf = buf.slice(n + 1);
                    let q;
                    try { q = JSON.parse(line); } catch (e) { continue; }
                    this.handle(q, sock);
                }
                if (buf.length > 65536) sock.destroy();
            });
            sock.on('error', () => {});
            sock.on('close', () => this.clients.delete(sock));
            this.write(sock, { state: this.state() });
        });
        this.server.listen(this.o.ctl, () => {
            try { fs.chmodSync(this.o.ctl, 0o666); } catch (e) { /* tests */ }
            log(`control socket ${this.o.ctl}`);
        });
    }

    write(sock, m) { try { sock.write(`${JSON.stringify(m)}\n`); } catch (e) { /* closed */ } }
    push() { const m = { state: this.state() }; this.clients.forEach((s) => this.write(s, m)); }

    handle(q, sock) {
        const reply = (ok, text) => this.write(sock, { reply: { op: q.op, ok, text } });
        if (q.op === 'get') return this.write(sock, { state: this.state() });
        if (q.op === 'set' && q.settings) {
            Object.assign(this.settings, cleanSettings(q.settings));
            this.logic.set(this.settings);
            this._save();
            return this.push();
        }
        if (q.op === 'pick' && SEAT_KINDS.indexOf(q.kind) >= 0) {
            const c = this.found && this.found[q.kind] && this.found[q.kind][q.i];
            if (!c) return reply(false, 'not in the list');
            this.settings.seat[q.kind] = c;
            this._save();
            if (q.kind === 'door') { this._subscribeDoor(); this.logic.onDoor(null, Date.now()); }
            log(`picked ${q.kind}: ${catalog.short(c)}`);
            return this.push();
        }
        if (q.op === 'clear' && SEAT_KINDS.indexOf(q.kind) >= 0) {
            this.settings.seat[q.kind] = null;
            if (q.kind === 'door') this.logic.onDoor(null, Date.now());
            this._save();
            return this.push();
        }
        if (q.op === 'test') {
            // only standing with the engine off, as the moves themselves
            if (this.logic.drive || this.logic.cond === 8) return reply(false, 'Switch the engine off first');
            if (this.busy) return reply(false, 'Busy');
            const s = this.settings;
            const done = (ok) => reply(ok, this.last ? this.last.text : '');
            if (q.what === 'exit') return this.exit({ mode: s.exitMode, back: s.back, up: s.up }).then(done);
            if (q.what === 'entry' || q.what === 'memory1') return this.memory(1, 'test').then(done);
            if (q.what === 'memory2') return this.memory(2, 'test').then(done);
            return reply(false, 'unknown test');
        }
        if (q.op === 'discover') { this.discover(); return this.push(); }
        if (q.op === 'export') { const r = this.exportUsb(); return reply(r.ok, r.text); }
        return reply(false, 'unknown request');
    }

    _save() {
        try { saveSettings(this.o.settings, this.settings); } catch (e) { log(`settings: ${e.message}`); }
    }

    state() {
        const s = this.settings, f = this.found;
        const list = (k) => (f ? f[k].map((c) => ({ label: catalog.short(c), detail: c.kind === 'method'
            ? `0x${c.svc.toString(16)}.${c.method} ${c.payload || '-'}` : `0x${c.svc.toString(16)} ev 0x${(c.event || 0).toString(16)} byte ${c.byte}` })) : []);
        const picked = (k) => (s.seat[k] ? { label: catalog.short(s.seat[k]), payload: s.seat[k].payload } : null);
        return {
            version: VERSION,
            settings: { enabled: s.enabled, exitMode: s.exitMode, back: s.back, up: s.up, trigger: s.trigger,
                entryOnStart: s.entryOnStart, entryOnlyAfterExit: s.entryOnlyAfterExit, exitDelayMs: s.exitDelayMs },
            seat: { memory: picked('memory'), position: picked('position'), door: picked('door') },
            car: this.logic.status(),
            bus: this.bus.up,
            busy: this.busy,
            catalog: this.catalogInfo,
            candidates: { memory: list('memory'), position: list('position'), door: list('door') },
            last: this.last,
        };
    }
}

function test() {
    const assert = require('assert');
    require('./logic').test();
    catalog.test();
    assert.strictEqual(doorOpen({ byte: 2, open: [1] }, '0000010f'), true);
    assert.strictEqual(doorOpen({ byte: 2, open: [1] }, '0000000f'), false);
    assert.strictEqual(doorOpen({ byte: 9, open: [1] }, '00'), null);
    assert.strictEqual(doorOpen({ byte: 0, mask: '0x01', open: [1] }, '03'), true);
    assert.strictEqual(conditionOf(CONDITION, '00000000000a0000'), 10);
    assert.deepStrictEqual(cleanSettings({ enabled: false, back: 150, up: 40.4, trigger: 'x', exitMode: 'memory2', junk: 1 }),
        { enabled: false, up: 40, exitMode: 'memory2' });
    const tmp = fs.mkdtempSync('/tmp/ee-');
    const f = path.join(tmp, 's.json');
    assert.strictEqual(loadSettings(f).trigger, 'door');
    saveSettings(f, Object.assign(loadSettings(f), { back: 70 }));
    assert.strictEqual(loadSettings(f).back, 70);
    assert.strictEqual(loadSettings(f).condition.event, 0x8002);
    console.log('easyentry self-check ok');
}

if (require.main === module) {
    if (process.argv.indexOf('--test') >= 0) { test(); } else {
        try { fs.mkdirSync(DIR); } catch (e) { /* there */ }
        const svc = new Service({ settings: SETTINGS, discovery: DISCOVERY, ctl: CTL, seatctl: SEATCTL, catalog: CATALOG });
        svc.start();
        const quit = () => { svc.bus.stop(); process.exit(0); };
        process.on('SIGTERM', quit);
        process.on('SIGINT', quit);
    }
}

module.exports = { Service, doorOpen, conditionOf, cleanSettings, loadSettings, VERSION };
