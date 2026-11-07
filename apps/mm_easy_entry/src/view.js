'use strict';
/*
 * view.js - Easy entry app: what each screen shows, from the tool's state (null: the tool is not running), and the
 * next value of each setting a row steps through. Pure (tools/test_view.js).
 */
const BACK_STEPS = [25, 50, 75, 100];
const UP_STEPS = [0, 25, 50, 75, 100];
const PICK_KINDS = { memory: 'Seat memory', position: 'Seat position', door: 'Driver door' };

const next = (steps, v) => steps[(steps.indexOf(v) + 1) % steps.length];   // a value not in steps: the first
const onOff = (b) => (b ? 'On' : 'Off');

const CONDITION = { 1: 'parked', 2: 'parked', 3: 'parked', 5: 'engine off', 7: 'ignition on', 8: 'starting', 10: 'engine on', 12: 'switching off' };

/* the main page's status line */
function statusLine(t) {
    if (!t) return 'Easy entry tool not running: install it from the Store, then restart the head unit';
    if (!t.bus) return 'Waiting for the car (SOME/IP)';
    if (!t.settings.enabled) return 'Switched off';
    const c = t.car || {};
    const parts = [c.cond === null || c.cond === undefined ? 'car state not known yet' : CONDITION[c.cond] || `state ${c.cond}`];
    if (c.door === true) parts.push('door open');
    if (c.door === false) parts.push('door closed');
    if (c.armed) parts.push('waiting to move back');
    if (!t.seat.memory) parts.push('seat memory not set up');
    return parts.join(' · ');
}

function lastLine(t) {
    if (!t || !t.last) return '';
    const what = { entry: 'Engine start', exit: 'Exit', test: 'Test' }[t.last.kind] || t.last.kind;
    const d = new Date(t.last.at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `Last: ${what} ${hm} · ${t.last.ok ? '' : 'failed: '}${t.last.text}`.slice(0, 120);
}

function main(t) {
    const s = t ? t.settings : null;
    const position = !!s && s.exitMode === 'position';
    return {
        status: statusLine(t),
        last: lastLine(t),
        rows: {
            eeEnabled: ['Easy entry / exit', s ? onOff(s.enabled) : '--'],
            eeExitMode: ['Exit position', s ? (position ? 'Far back and up' : 'Memory 2') : '--'],
            eeBack: ['Back travel', s ? `${s.back} %` : '--'],
            eeUp: ['Raise seat', s ? `${s.up} %` : '--'],
            eeTrigger: ['Move back when', s ? (s.trigger === 'door' ? 'Door opens' : 'Engine off') : '--'],
            eeEntry: ['Memory 1 at engine start', s ? onOff(s.entryOnStart) : '--'],
        },
        visible: { eeBack: position, eeUp: position },
        positionNote: position && t && !t.seat.position ? 'Seat position not set up yet: memory 2 is used for the exit' : '',
    };
}

function setup(t) {
    const c = t && t.catalog;
    const label = (k) => (t && t.seat[k] ? t.seat[k].label : 'Not set');
    return {
        status: !t ? 'Easy entry tool not running' : !c || !c.present ? 'No SOME/IP catalog found on this head unit'
            : `Catalog: ${c.interfaces} services · candidates: memory ${t.candidates.memory.length}, ` +
              `position ${t.candidates.position.length}, door ${t.candidates.door.length}`,
        rows: { eeSetMemory: ['Seat memory', label('memory')], eeSetPosition: ['Seat position', label('position')],
            eeSetDoor: ['Driver door', label('door')] },
    };
}

function pick(t, kind) {
    const list = (t && t.candidates[kind]) || [];
    return {
        what: list.length ? `${PICK_KINDS[kind]}: pick one, then try it on the Test page` : `${PICK_KINDS[kind]}: nothing found in the catalog`,
        rows: list.map((c) => [c.label, c.detail.slice(0, 40)]),
    };
}

function test(t) {
    const s = t && t.settings;
    return {
        note: !t ? 'Easy entry tool not running' : t.car && (t.car.drive || t.car.cond === 8)
            ? 'Switch the engine off first' : 'Car parked, engine off: the seat moves when you tap',
        exit: s ? (s.exitMode === 'position' ? `Move for exit (back ${s.back} %, up ${s.up} %)` : 'Move for exit (memory 2)') : 'Move for exit',
    };
}

/* the settings a tap on a main-page row asks for */
function tap(t, row) {
    const s = t && t.settings;
    if (!s) return null;
    switch (row) {
    case 'eeEnabled': return { enabled: !s.enabled };
    case 'eeExitMode': return { exitMode: s.exitMode === 'position' ? 'memory2' : 'position' };
    case 'eeBack': return { back: next(BACK_STEPS, s.back) };
    case 'eeUp': return { up: next(UP_STEPS, s.up) };
    case 'eeTrigger': return { trigger: s.trigger === 'door' ? 'engineoff' : 'door' };
    case 'eeEntry': return { entryOnStart: !s.entryOnStart };
    default: return null;
    }
}

module.exports = { main, setup, pick, test, tap, statusLine, lastLine, BACK_STEPS, UP_STEPS, PICK_KINDS };
