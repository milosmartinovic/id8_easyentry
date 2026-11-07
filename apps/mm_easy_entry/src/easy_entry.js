'use strict';
/*
 * easy_entry - the Easy entry app (iDrive 8): the screens of the mm-easy-entry tool, which does the work as a root
 * service (tools/mm-easy-entry). The app shows the tool's state and sends it what the driver changes, over the
 * tool's control socket (src/client.js); it moves nothing itself.
 *
 * Screens, with the HMI's own list widgets (tools/gen_rhmi.js):
 *   Easy entry           status · Easy entry / exit On|Off · Exit position Far back and up|Memory 2 · Back travel %
 *                        · Raise seat % · Move back when Door opens|Engine off · Memory 1 at engine start On|Off
 *                        · Seat and door setup · Test · the last move
 *   Seat and door setup  which catalog entries move the seat (memory, position) and report the driver's door; a
 *                        row opens its pick list; search again; save the findings to a USB stick
 *   Pick                 the candidates the tool found for one of them, Not set
 *   Test                 Move for exit, Memory 1, Memory 2 (the tool refuses while the engine runs)
 * A row with a value steps it on each press. The RHMI start-up, tile and shutdown follow the Store's
 * (robertnisipeanu/mgu-store apps/robertn_store, GPL-3.0-or-later).
 */
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { ToolClient } = require('./client.js');
const view = require('./view.js');

const logger = logging.getSDKLogger();
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ID8_LABELS = new Set(['eeStatus', 'eePositionNote', 'eeLast', 'eeHmiID8', 'eeSetupStatus', 'eeSetupNote', 'eePickWhat',
    'eeTestNote', 'eeTestResult']);

const S = { main: 'ST_OnlineApps_EasyEntry', setup: 'ST_OnlineApps_EasyEntrySetup', pick: 'ST_OnlineApps_EasyEntryPick',
    test: 'ST_OnlineApps_EasyEntryTest' };
const MAIN_ROWS = ['eeEnabled', 'eeExitMode', 'eeBack', 'eeUp', 'eeTrigger', 'eeEntry'];
const SETUP_ROWS = { eeSetMemory: 'memory', eeSetPosition: 'position', eeSetDoor: 'door' };
const COMPONENTS = ['eeStatus', 'eePositionNote', 'eeLast', 'eeNavSetup', 'eeNavTest', 'eeSetupStatus', 'eeRescan', 'eeExport',
    'eeSetupNote', 'eePickWhat', 'eePickList', 'eePickNone', 'eeTestNote', 'eeTestExit', 'eeTestMem1', 'eeTestMem2', 'eeTestResult']
    .concat(MAIN_ROWS, Object.keys(SETUP_ROWS));

class EasyEntry extends OnlineApp {
    constructor() {
        super();
        this._states = {};
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._sizing = {};
        this._visibleStates = new Set();
        this._visible = false;
        this._hideTimer = null;
        this._shutdownPromise = null;
        this._tool = null;              // the tool's last state, null: not connected
        this._pickKind = 'memory';      // what the Pick page lists
        this._note = '';                // the setup page's last answer (export)
        this._testResult = '';
        this._client = new ToolClient();
        this._client.on('state', (st) => { this._tool = st; this._render(); });
        this._client.on('reply', (r) => {
            if (r.op === 'test') this._testResult = `${r.ok ? 'Sent' : 'Not sent'}: ${r.text || ''}`;
            if (r.op === 'export') this._note = r.text || '';
            if (r.op === 'pick' && !r.ok) this._note = r.text || '';
            this._render();
        });
        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`easy entry init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) { this._visibleStates.clear(); this._setVisible(false); }
        });
    }

    _appInitialized() {
        logger.info('easy entry starting');
        this._client.connect();
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => this.initialized())
            .then(() => {
                const lastUuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        for (const k of Object.keys(S)) {
            this._states[k] = rhmi.getByName(S[k]);
            if (!this._states[k]) return Promise.reject(new Error(`uiDescription has no ${S[k]}`));
        }
        COMPONENTS.forEach((n) => {
            this._components[n] = rhmi.getByName(n);
            if (!this._components[n]) logger.warn(`BIND MISS: ${n}`);
        });
        MAIN_ROWS.forEach((n) => this._bind(n, () => this._setting(view.tap(this._tool, n))));
        Object.keys(SETUP_ROWS).forEach((n) => this._bind(n, () => {
            this._pickKind = SETUP_ROWS[n];
            this._openState(S.pick);
        }));
        this._bind('eeNavSetup', () => this._openState(S.setup));
        this._bind('eeNavTest', () => { this._testResult = ''; this._openState(S.test); });
        this._bind('eeRescan', () => { this._note = ''; this._client.send({ op: 'discover' }); });
        this._bind('eeExport', () => { this._note = 'Saving...'; this._render(); this._client.send({ op: 'export' }); });
        this._bind('eePickList', (row) => { this._client.send({ op: 'pick', kind: this._pickKind, i: row }); this._closeState(S.pick); });
        this._bind('eePickNone', () => { this._client.send({ op: 'clear', kind: this._pickKind }); this._closeState(S.pick); });
        const test = (what) => () => { this._testResult = 'Sending...'; this._render(); this._client.send({ op: 'test', what }); };
        this._bind('eeTestExit', test('exit'));
        this._bind('eeTestMem1', test('memory1'));
        this._bind('eeTestMem2', test('memory2'));
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler, Number((ev.parameterMap || {})[ROW_KEY]) || 0);
        });
        rhmi.on('restoreHmi', () => { this._written = {}; this._render(); });
        Object.keys(S).forEach((k) => this._states[k].on('visible', (event) => {
            const on = event && (event.visible === true || event.visible === 'true' || event.visible === 1);
            if (on) {
                this._visibleStates.add(k);
                this._setVisible(true);
                this._render();
            } else {
                // moving between pages hides one before showing the next
                this._visibleStates.delete(k);
                clearTimeout(this._hideTimer);
                this._hideTimer = setTimeout(() => { if (!this._visibleStates.size) this._setVisible(false); }, HIDE_SETTLE_MS);
            }
        }));
        return Promise.all(Object.keys(S).map((k) => this._states[k].updateResources()));
    }

    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._states.main))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info('entry point ENABLED'));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* on screen: everything written again (the HMI may have dropped it), and the platform told */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) return;
        this._visible = visible;
        clearTimeout(this._hideTimer);
        logger.info(`screen ${visible ? 'visible' : 'hidden'}`);
        if (visible) {
            this._written = {};
            this._client.connect();
            this._render();
        }
        if (!this._appStatusService) return;
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()]
            : [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((r) => Promise.resolve(r).catch((err) => logger.warn(`app status report failed: ${err && err.message}`)));
    }

    _openState(name) {
        if (this._shutdownPromise) return;
        this._render();
        Promise.resolve(this.rhmiApplication.openState(name)).catch((err) => logger.warn(`openState ${name}: ${err && err.message}`));
    }

    _closeState(name) {
        return Promise.resolve(this.rhmiApplication.closeState(name)).catch((err) => logger.warn(`closeState ${name}: ${err && err.message}`));
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) return;
        try { this._actionById[Number(comp.getId())] = { name, handler }; } catch (e) { /* component events only */ }
        comp.on('action', (ev) => this._press(name, handler, Number(ev && ev.row) || 0));
    }

    /* presses come as the component's 'action' and the raw userEvent: one of them counts */
    _press(name, handler, row) {
        const now = Date.now(), key = `${name}.${row}`;
        if (now - (this._lastPress[key] || 0) < PRESS_DEDUPE_MS) return;
        this._lastPress[key] = now;
        logger.info(`press ${name} row ${row}`);
        try { handler(row); } catch (err) { logger.warn(`${name} failed: ${err && err.message}`); }
    }

    _setting(s) {
        if (s && this._client.send({ op: 'set', settings: s })) {
            // shown at once; the tool's state confirms it
            Object.assign(this._tool.settings, s);
            this._render();
        }
    }

    /* ---- rendering: a cell is written only when it changed ---- */
    _set(name, cell, value, row) {
        const comp = this._components[name];
        if (!ID8_LABELS.has(name)) cell = { Text: 'PrimaryText', Value: 'FrequencyText' }[cell] || cell;
        const key = `${name}.${row || 0}.${cell}`;
        if (!comp || this._written[key] === value) return;
        this._written[key] = value;
        Promise.resolve(comp.setValue(row || 0, cell, value, 'Text')).catch((err) => logger.warn(`render ${key}: ${err && err.message}`));
    }

    _show(name, visible) {
        const comp = this._components[name], key = `${name}.visible`;
        if (!comp || this._written[key] === visible) return;
        this._written[key] = visible;
        Promise.resolve(comp.setProperty('Visible', visible ? 1 : 0, 'UInt')).catch((err) => logger.warn(`visibility ${name}: ${err && err.message}`));
    }

    _text(name, text) {
        if (text) this._set(name, 'Text', text);
        this._show(name, !!text);
    }

    _row(name, cells) {
        this._set(name, 'Text', cells[0]);
        this._set(name, 'Value', cells[1]);
    }

    /* a list's row count first, then its cells (a cell past the count would grow the list) */
    _list(name, rows) {
        const comp = this._components[name];
        this._show(name, rows.length > 0);
        if (!comp || this._sizing[name]) return;
        const countKey = `${name}.rows`;
        if (this._written[countKey] !== rows.length) {
            Object.keys(this._written).filter((k) => k.indexOf(`${name}.`) === 0).forEach((k) => delete this._written[k]);
            this._written[countKey] = rows.length;
            this._sizing[name] = true;
            Promise.resolve(comp.setRowCount(rows.length))
                .catch((err) => logger.warn(`row count ${name}: ${err && err.message}`))
                .then(() => { this._sizing[name] = false; this._render(); });
            return;
        }
        rows.forEach((r, i) => { this._set(name, 'Text', r[0], i); this._set(name, 'Value', r[1], i); });
    }

    _render() {
        if (!this._visible || this._shutdownPromise || !this.rhmiApplication) return;
        const t = this._tool;
        const m = view.main(t);
        this._text('eeStatus', m.status);
        MAIN_ROWS.forEach((n) => this._row(n, m.rows[n]));
        this._show('eeBack', m.visible.eeBack);
        this._show('eeUp', m.visible.eeUp);
        this._text('eePositionNote', m.positionNote);
        this._text('eeLast', m.last);
        const su = view.setup(t);
        this._text('eeSetupStatus', su.status);
        Object.keys(SETUP_ROWS).forEach((n) => this._row(n, su.rows[n]));
        this._text('eeSetupNote', this._note);
        const p = view.pick(t, this._pickKind);
        this._text('eePickWhat', p.what);
        this._list('eePickList', p.rows);
        const ts = view.test(t);
        this._text('eeTestNote', ts.note);
        this._set('eeTestExit', 'Text', ts.exit);
        this._text('eeTestResult', this._testResult);
    }

    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        logger.info(`easy entry shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        this._client.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new EasyEntry();
app.start().catch((err) => {
    /* stays resident so the manager can stop or restart it */
    logger.error(`easy entry failed to start: ${err && err.message}`);
});
