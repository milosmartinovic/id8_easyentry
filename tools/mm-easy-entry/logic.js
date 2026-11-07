'use strict';
/*
 * logic.js - mm-easy-entry: when to move the driver's seat. Pure: events in, actions out (no I/O), so it is
 * tested without a car (node logic.js --test).
 *
 * The car's state comes from VehicleCondition.statusConditionVehicle (BMW's vehicle state):
 *   1 / 2 PARKEN, 3 STANDFUNKTIONEN, 5 WOHNEN (living, no ignition), 7 PRUEFEN_ANALYSE_DIAGNOSE (ignition on),
 *   8 FAHRBEREITSCHAFT_HERSTELLEN (drive readiness starting), 10 FAHREN (drive-ready: engine running, also while
 *   auto start-stop has the engine stopped at a light), 12 FAHRBEREITSCHAFT_BEENDEN (drive readiness ending).
 * Drive-ready (10) is what "engine on" means here: the engine's own run state goes to off at every auto-stop,
 * which must never move the seat.
 *
 *   engine start  (to 10)            -> 'entry' (the seat's memory 1), when entryOnStart
 *   engine off    (10 to anything)   -> armed; then 'exit' at the driver's door opening (trigger 'door'), or
 *                                       exitDelayMs later (trigger 'engineoff', or 'door' without a door signal)
 * Never an exit while drive-ready or starting (8, 10); one exit per engine off; the first state seen after the
 * tool starts moves nothing, except drive-ready seen within BOOT_GRACE_MS of the start (the head unit booted with
 * the engine start), which is an engine start.
 */
const DRIVE = 10, STARTING = 8;
const BOOT_GRACE_MS = 120000;
const MIN_GAP_MS = 4000;              // between two seat moves

const DEFAULTS = {
    enabled: true,
    exitMode: 'position',             // 'position' (far back / up, as far as back / up say) or 'memory2'
    back: 100,                        // % of the remaining travel backwards (position mode)
    up: 100,                          // % of the remaining travel upwards (position mode)
    trigger: 'door',                  // 'door' or 'engineoff'
    entryOnStart: true,               // memory 1 at engine start
    entryOnlyAfterExit: false,        // ... only when the tool moved the seat for the exit
    exitDelayMs: 1500,
};

class Logic {
    constructor(settings, startedAt) {
        this.s = Object.assign({}, DEFAULTS, settings || {});
        this.startedAt = startedAt || 0;
        this.cond = null;             // the last statusConditionVehicle
        this.drive = null;            // drive-ready (null: not known yet)
        this.door = null;             // driver's door open (null: no door signal)
        this.armed = null;            // { at, due } an exit waiting for the door / its delay
        this.exited = false;          // the tool moved the seat back since the last start
        this.lastMove = -Infinity;
        this.note = '';               // why the last exit / entry happened or did not
    }

    set(settings) {
        Object.assign(this.s, settings);
        if (!this.s.enabled) this.armed = null;
    }

    /* a statusConditionVehicle value (number) at time t */
    onCondition(n, t) {
        if (typeof n !== 'number' || n < 1 || n > 14) return [];
        const was = this.drive, first = this.cond === null;
        this.cond = n;
        const drive = n === DRIVE;
        this.drive = drive;
        if (first) {
            if (drive && t - this.startedAt <= BOOT_GRACE_MS) return this._start(t);
            return [];
        }
        if (drive && !was) return this._start(t);
        if (!drive && was && n !== STARTING) return this._off(t);
        return [];
    }

    /* the driver's door: true open, false closed, null the signal went away */
    onDoor(open, t) {
        const was = this.door;
        this.door = open === null || open === undefined ? null : !!open;
        if (this.door === true && was === false && this.armed && this.s.trigger === 'door') {
            return this._exit(t, 'door opened after engine off');
        }
        return [];
    }

    /* timers: the delayed exit */
    tick(t) {
        if (this.armed && this.armed.due !== null && t >= this.armed.due) {
            const why = this.s.trigger !== 'door' ? 'engine off' : this.door ? 'engine off, door open' : 'engine off (no door signal)';
            return this._exit(t, why);
        }
        return [];
    }

    _start(t) {
        this.armed = null;
        const after = this.exited;
        this.exited = false;
        if (!this.s.enabled || !this.s.entryOnStart) return [];
        if (this.s.entryOnlyAfterExit && !after) { this.note = 'engine start: seat not moved for exit, left as it is'; return []; }
        if (t - this.lastMove < MIN_GAP_MS) return [];
        this.lastMove = t;
        this.note = 'engine start: memory 1';
        return [{ kind: 'entry', slot: 1 }];
    }

    _off(t) {
        if (!this.s.enabled) return [];
        // door trigger: wait for the door when there is a door signal, else the delay
        // the door already open at engine off counts as opened then
        const waitDoor = this.s.trigger === 'door' && this.door === false;
        this.armed = { at: t, due: waitDoor ? null : t + this.s.exitDelayMs };
        this.note = waitDoor ? 'engine off: waiting for the driver door' : 'engine off';
        return [];
    }

    _exit(t, why) {
        this.armed = null;
        if (!this.s.enabled || this.drive || this.cond === STARTING) return [];
        if (t - this.lastMove < MIN_GAP_MS) return [];
        this.lastMove = t;
        this.exited = true;
        this.note = why;
        return [{ kind: 'exit', mode: this.s.exitMode, back: this.s.back, up: this.s.up }];
    }

    status() {
        return { cond: this.cond, drive: this.drive, door: this.door, armed: !!this.armed, exited: this.exited, note: this.note };
    }
}

function test() {
    const assert = require('assert');
    const kinds = (a) => a.map((x) => x.kind).join(',');
    // the head unit boots, the driver starts the engine, drives, switches off, opens the door
    let l = new Logic({}, 0);
    l.onDoor(false, 0);
    assert.strictEqual(kinds(l.onCondition(5, 1000)), '', 'first state: nothing');
    assert.strictEqual(kinds(l.onCondition(8, 2000)), '');
    assert.deepStrictEqual(l.onCondition(10, 3000), [{ kind: 'entry', slot: 1 }]);
    assert.strictEqual(kinds(l.onCondition(10, 9000)), '', 'still drive-ready');
    assert.strictEqual(kinds(l.onCondition(12, 600000)), '', 'engine off: armed, waits for the door');
    assert.strictEqual(kinds(l.tick(700000)), '', 'door trigger: no timer while a door signal exists');
    assert.deepStrictEqual(l.onDoor(true, 710000), [{ kind: 'exit', mode: 'position', back: 100, up: 100 }]);
    assert.strictEqual(kinds(l.onDoor(false, 715000)) + kinds(l.onDoor(true, 720000)), '', 'one exit per engine off');
    // drive-ready seen first, soon after the start: the engine start booted the head unit
    l = new Logic({}, 0);
    assert.strictEqual(kinds(l.onCondition(10, 30000)), 'entry');
    l = new Logic({}, 0);
    assert.strictEqual(kinds(l.onCondition(10, 300000)), '', 'tool restarted while driving: nothing');
    // auto start-stop keeps drive-ready: nothing; 8 between is no engine off
    assert.strictEqual(kinds(l.onCondition(8, 301000)), '');
    assert.strictEqual(l.armed, null);
    // no door signal: the delay
    l = new Logic({ exitMode: 'memory2' }, 0);
    l.onCondition(5, 1); l.onCondition(10, 10000);
    l.onCondition(12, 20000);
    assert.strictEqual(kinds(l.tick(21000)), '');
    assert.deepStrictEqual(l.tick(21500), [{ kind: 'exit', mode: 'memory2', back: 100, up: 100 }]);
    // the door already open when the engine goes off: the delay
    l = new Logic({}, 0);
    l.onDoor(false, 0); l.onCondition(5, 1); l.onCondition(10, 10000); l.onDoor(true, 15000);
    l.onCondition(12, 20000);
    assert.strictEqual(kinds(l.tick(21500)), 'exit');
    // engine-off trigger ignores the door
    l = new Logic({ trigger: 'engineoff', exitDelayMs: 500 }, 0);
    l.onDoor(false, 0); l.onCondition(5, 1); l.onCondition(10, 10000); l.onCondition(5, 20000);
    assert.strictEqual(kinds(l.tick(20500)), 'exit');
    // engine started again before the door opened: no exit, entry instead
    l = new Logic({}, 0);
    l.onDoor(false, 0); l.onCondition(5, 1); l.onCondition(10, 10000); l.onCondition(12, 20000);
    assert.strictEqual(kinds(l.onCondition(10, 30000)), 'entry');
    assert.strictEqual(kinds(l.onDoor(true, 31000)), '', 'drive-ready: never an exit');
    // disabled: nothing at all
    l = new Logic({ enabled: false }, 0);
    l.onDoor(false, 0); l.onCondition(5, 1);
    assert.strictEqual(kinds(l.onCondition(10, 10000)) + kinds(l.onCondition(12, 20000)) + kinds(l.onDoor(true, 21000)), '');
    // entry only after an exit
    l = new Logic({ entryOnlyAfterExit: true }, 0);
    l.onDoor(false, 0); l.onCondition(5, 1);
    assert.strictEqual(kinds(l.onCondition(10, 10000)), '', 'no exit before: memory 1 not recalled');
    l.onCondition(12, 20000); l.onDoor(true, 25000);
    assert.strictEqual(kinds(l.onCondition(10, 40000)), 'entry');
    // two moves never closer than MIN_GAP_MS
    l = new Logic({ trigger: 'engineoff', exitDelayMs: 0 }, 0);
    l.onCondition(5, 1); l.onCondition(10, 10000); l.onCondition(12, 11000);
    assert.strictEqual(kinds(l.tick(11000)), '', 'too soon after the entry');
    // invalid values are ignored
    assert.deepStrictEqual(l.onCondition(15, 50000), []);
    console.log('logic self-check ok');
}

module.exports = { Logic, DEFAULTS, DRIVE, test };
if (require.main === module) test();
