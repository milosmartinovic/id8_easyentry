'use strict';
/*
 * someip.js - mm-easy-entry: one long-lived `seatctl serve` (seatctl.cpp) for every SOME/IP request and
 * subscription; restarted when it ends, and every subscription made again.
 *
 *   const bus = new Bus(path, log);
 *   bus.on('event', (svc, ev, hex) => ...); bus.on('up' | 'down')
 *   bus.subscribe({ svc, inst, major, group, events: [..] })
 *   bus.call({ svc, inst, method, major, tcp, reply }, hex) -> Promise<{ ok, hex, error, why }>
 */
const EventEmitter = require('events');
const { spawn } = require('child_process');

const RESTART_MS = 5000;
const CALL_MS = 8000;              // seatctl answers within 3 s (+ availability); a hard stop after this

const h = (n) => `0x${Number(n).toString(16)}`;

class Bus extends EventEmitter {
    constructor(bin, log) {
        super();
        this.bin = bin; this.log = log || (() => {});
        this.p = null; this.up = false; this.seq = 0; this.waiting = {}; this.subs = []; this.buf = '';
        this.stopped = false; this.failures = 0;
    }

    start() {
        if (this.p || this.stopped) return;
        let p;
        try { p = spawn(this.bin, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.p = {}; this._ended(this.p, `spawn: ${e.message}`); return; }
        this.p = p;
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => this._data(d));
        p.stderr.setEncoding('utf8');
        p.stderr.on('data', (d) => d.split('\n').filter(Boolean).slice(0, 5).forEach((l) => this.log(`seatctl: ${l.slice(0, 200)}`)));
        p.on('error', (e) => this._ended(p, e.message));
        p.on('exit', (code, sig) => this._ended(p, `exit ${code === null ? sig : code}`));
        p.stdin.on('error', () => {});
    }

    stop() { this.stopped = true; if (this.p) this.p.kill(); }

    _ended(p, why) {
        if (this.p !== p) return;      // 'error' and 'exit' of one process: handled once
        this.log(`seatctl ended (${why})`);
        this.p = null;
        const was = this.up;
        this.up = false;
        this.failures++;
        Object.keys(this.waiting).forEach((t) => this._answer(t, { ok: false, why: 'seatctl ended' }));
        if (was) this.emit('down', why);
        if (!this.stopped) setTimeout(() => this.start(), Math.min(RESTART_MS * this.failures, 60000));
    }

    _data(d) {
        this.buf += d;
        let n;
        while ((n = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, n).trim();
            this.buf = this.buf.slice(n + 1);
            if (line) this._line(line);
        }
    }

    _line(line) {
        const w = line.split(/\s+/);
        if (line === 'state registered') {
            this.up = true; this.failures = 0;
            this.log('seatctl registered with vsomeip');
            this.subs.forEach((s) => this._sub(s));
            this.emit('up');
            return;
        }
        if (w[0] === 'ev' && w.length >= 3) { this.emit('event', parseInt(w[1], 16), parseInt(w[2], 16), w[3] || ''); return; }
        if (w[0] === 'avail') { this.emit('avail', parseInt(w[1], 16), Number(w[2]), w[3] === '1'); return; }
        if (w[0] === 'error') { this.log(line); return; }
        const t = w[0];
        if (!this.waiting[t]) return;
        if (w[1] === 'ok') this._answer(t, { ok: true, hex: w[2] || '' });
        else if (w[1] === 'sent') this._answer(t, { ok: true, hex: '' });
        else if (w[1] === 'error') this._answer(t, { ok: false, error: Number(w[2]), hex: w[3] || '', why: `SOME/IP error ${w[2]}` });
        else if (w[1] === 'subscribed') this._answer(t, { ok: true });
        else this._answer(t, { ok: false, why: w.slice(1).join(' ') });   // noreply, unavailable, bad ...
    }

    _answer(t, r) {
        const wt = this.waiting[t];
        if (!wt) return;
        delete this.waiting[t];
        clearTimeout(wt.timer);
        wt.resolve(r);
    }

    _send(cmd) {
        return new Promise((resolve) => {
            if (!this.p || !this.up) { resolve({ ok: false, why: 'SOME/IP client not running' }); return; }
            const t = `q${++this.seq}`;
            this.waiting[t] = { resolve, timer: setTimeout(() => this._answer(t, { ok: false, why: 'timeout' }), CALL_MS) };
            this.p.stdin.write(`${t} ${cmd}\n`);
        });
    }

    _sub(s) {
        return this._send(`sub ${h(s.svc)} ${s.inst} ${s.major} ${s.group} ${s.events.map(h).join(',')}`)
            .then((r) => { if (!r.ok) this.log(`subscribe ${h(s.svc)}: ${r.why}`); return r; });
    }

    /* kept: made again after every restart of seatctl */
    subscribe(s) {
        const key = (x) => `${x.svc}.${x.inst}.${x.group}.${x.events.join(',')}`;
        if (this.subs.some((x) => key(x) === key(s))) return Promise.resolve({ ok: true });
        this.subs.push(s);
        return this.up ? this._sub(s) : Promise.resolve({ ok: false, why: 'later' });
    }

    call(m, hex) {
        const verb = m.reply === false ? 'send' : 'call';
        return this._send(`${verb} ${h(m.svc)} ${m.inst || 1} ${h(m.method)} ${m.major || 1} ${m.tcp === false ? 'udp' : 'tcp'} ${hex || ''}`.trim());
    }
}

module.exports = { Bus };
