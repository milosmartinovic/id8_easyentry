#!/usr/bin/env node
'use strict';
/*
 * test_app.js - the Easy entry app without a head unit: view.js, then src/easy_entry.js on a fake oap-sdk and a
 * fake RHMI built from the generated uiDescription (every name it binds exists; presses reach the tool's socket;
 * what it writes follows the tool's state).
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const view = require('../src/view.js');

/* ---- view ---- */
const state = (o) => Object.assign({ version: '0.1.0', bus: true, busy: false,
    settings: { enabled: true, exitMode: 'position', back: 100, up: 100, trigger: 'door', entryOnStart: true, entryOnlyAfterExit: false },
    seat: { memory: { label: 'vehicle.Seat.requestMemory', payload: '{slot}' }, position: null, door: null },
    car: { cond: 5, drive: false, door: false, armed: false, exited: false, note: '' },
    catalog: { present: true, interfaces: 812 },
    candidates: { memory: [{ label: 'vehicle.Seat.requestMemory', detail: '0xb5aa.12 {slot}' }], position: [], door: [] },
    last: null }, o || {});
assert.ok(/not running/.test(view.statusLine(null)));
assert.strictEqual(view.statusLine(state()), 'engine off · door closed');
assert.strictEqual(view.statusLine(state({ seat: { memory: null } })), 'engine off · door closed · seat memory not set up');
assert.deepStrictEqual(view.tap(state(), 'eeBack'), { back: 25 });
assert.deepStrictEqual(view.tap(state(), 'eeUp'), { up: 0 });
assert.deepStrictEqual(view.tap(state(), 'eeExitMode'), { exitMode: 'memory2' });
assert.deepStrictEqual(view.tap(state(), 'eeTrigger'), { trigger: 'engineoff' });
assert.strictEqual(view.tap(null, 'eeEnabled'), null);
assert.ok(/memory 2 is used/.test(view.main(state()).positionNote));
assert.deepStrictEqual(view.main(state({ settings: Object.assign({}, state().settings, { exitMode: 'memory2' }) })).visible, { eeBack: false, eeUp: false });
assert.strictEqual(view.pick(state(), 'memory').rows.length, 1);
assert.ok(/Switch the engine off/.test(view.test(state({ car: { cond: 10, drive: true } })).note));
assert.ok(/^Last: Exit \d\d:\d\d · memory 2: sent$/.test(view.lastLine(state({ last: { kind: 'exit', at: Date.now(), ok: true, text: 'memory 2: sent' } }))));
console.log('view ok');

/* ---- the app on a fake platform ---- */
const ui = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package', 'rhmiData', 'uiDescriptions', 'ID8', 'uiDescription.json'), 'utf8'));
const byName = {};
let nextId = 1;
class Comp extends EventEmitter {
    constructor(name, kind) { super(); this.name = name; this.kind = kind; this.id = nextId++; this.cells = {}; this.visible = 1; this.rows = 1; }
    getId() { return this.id; }
    setValue(row, cell, value) { this.cells[`${row}.${cell}`] = value; return Promise.resolve(); }
    setProperty(p, v) { if (p === 'Visible') this.visible = v; return Promise.resolve(); }
    setRowCount(n) { this.rows = n; return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    byName[c.name] = new Comp(c.name, 'state');
    Object.keys(c.components).forEach((k) => { const x = c.components[k]; byName[x.name] = new Comp(x.name, x.type); });
});
const opened = [];
const rhmi = Object.assign(new EventEmitter(), {
    getByName: (n) => byName[n] || null,
    openState: (n) => { opened.push(n); byName[n].emit('visible', { visible: true }); return Promise.resolve(); },
    closeState: (n) => { opened.push(`-${n}`); return Promise.resolve(); },
    mapEntryState: () => Promise.resolve(),
    openEntryState: () => { byName.ST_OnlineApps_EasyEntry.emit('visible', { visible: true }); return Promise.resolve(); },
});
let theApp = null;
class FakeOnlineApp extends EventEmitter {
    constructor() { super(); theApp = this; this.rhmiApplication = rhmi; this.appDescription = { application: { entryPoints: [{ uuid: 'u1' }] } }; }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    initialized() { return Promise.resolve(); }
    getEntryPoints() { return [{ getDescription: () => ({ uuid: 'u1', name: 'ee' }), init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }]; }
    getLastExecutedEntryPointUuid() { return 'u1'; }
    destroyBundles() { return Promise.resolve(); }
}
const quiet = { info: () => {}, warn: (m) => { if (/BIND MISS/.test(m)) throw new Error(m); }, error: (m) => { throw new Error(m); } };
const fakes = { 'oap-sdk/src/core/OnlineApp.js': FakeOnlineApp, 'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet } };
const load = Module._load;
Module._load = function (req, parent, isMain) { return fakes[req] || load.apply(this, arguments); };

// the tool: a socket speaking its protocol
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-app-'));
const sockPath = path.join(dir, 'ctl.sock');
const got = [];
let toolState = state();
const server = net.createServer((s) => {
    s.write(`${JSON.stringify({ state: toolState })}\n`);
    let b = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
        b += d;
        let n;
        while ((n = b.indexOf('\n')) >= 0) {
            const q = JSON.parse(b.slice(0, n)); b = b.slice(n + 1); got.push(q);
            if (q.op === 'set') { toolState = state({ settings: Object.assign({}, toolState.settings, q.settings) }); s.write(`${JSON.stringify({ state: toolState })}\n`); }
            if (q.op === 'test') s.write(`${JSON.stringify({ reply: { op: 'test', ok: true, text: 'memory 2: sent' } })}\n`);
        }
    });
});
server.listen(sockPath, () => {
    const client = require('../src/client.js');
    const Orig = client.ToolClient;
    client.ToolClient = class extends Orig { constructor() { super(sockPath); } };
    require('../src/easy_entry.js');
    const press = (n, row) => byName[n].emit('action', { row: row || 0 });
    setTimeout(() => {
        const c = (n, cell, row) => byName[n].cells[`${row || 0}.${cell}`];
        assert.strictEqual(c('eeStatus', 'Text'), 'engine off · door closed');
        assert.strictEqual(c('eeEnabled', 'PrimaryText'), 'Easy entry / exit');
        assert.strictEqual(c('eeEnabled', 'FrequencyText'), 'On');
        assert.strictEqual(c('eeExitMode', 'FrequencyText'), 'Far back and up');
        assert.strictEqual(byName.eePositionNote.visible, 1);
        press('eeEnabled');
        press('eeBack');
        setTimeout(() => {
            assert.deepStrictEqual(got.filter((q) => q.op === 'set').map((q) => q.settings), [{ enabled: false }, { back: 25 }]);
            assert.strictEqual(c('eeEnabled', 'FrequencyText'), 'Off');
            assert.strictEqual(c('eeBack', 'FrequencyText'), '25 %');
            press('eeSetMemory');
            assert.strictEqual(opened[opened.length - 1], 'ST_OnlineApps_EasyEntryPick');
            setTimeout(() => {
                assert.strictEqual(byName.eePickList.rows, 1);
                assert.strictEqual(c('eePickList', 'PrimaryText', 0), 'vehicle.Seat.requestMemory');
                press('eePickList', 0);
                press('eeNavTest');
                press('eeTestMem2');
                setTimeout(() => {
                    assert.deepStrictEqual(got.find((q) => q.op === 'pick'), { op: 'pick', kind: 'memory', i: 0 });
                    assert.deepStrictEqual(got.find((q) => q.op === 'test'), { op: 'test', what: 'memory2' });
                    assert.strictEqual(c('eeTestResult', 'Text'), 'Sent: memory 2: sent');
                    theApp.emit('shutdown', 'test');
                    server.close();
                    console.log('app ok');
                }, 150);
            }, 150);
        }, 150);
    }, 300);
});
const exit = process.exit;
process.exit = (code) => { if (code) exit(code); };
