'use strict';
/*
 * client.js - Easy entry app: the tool's control socket (/run/mm-easy-entry/ctl.sock, JSON lines), reconnected
 * while the app runs. Emits 'state' (the tool's state, null while not connected) and 'reply' ({ op, ok, text }).
 */
const EventEmitter = require('events');
const net = require('net');

const SOCKET = '/run/mm-easy-entry/ctl.sock';
const RETRY_MS = 2000;

class ToolClient extends EventEmitter {
    constructor(path) {
        super();
        this.path = path || SOCKET;
        this.sock = null; this.connecting = false; this.closed = false; this.timer = null;
    }

    connect() {
        if (this.sock || this.connecting || this.closed) return;
        this.connecting = true;
        const s = net.connect(this.path);
        let buf = '';
        s.setEncoding('utf8');
        s.on('connect', () => { this.connecting = false; this.sock = s; });
        s.on('data', (d) => {
            buf += d;
            let n;
            while ((n = buf.indexOf('\n')) >= 0) {
                let m = null;
                try { m = JSON.parse(buf.slice(0, n)); } catch (e) { /* skip */ }
                buf = buf.slice(n + 1);
                if (m && m.state) this.emit('state', m.state);
                if (m && m.reply) this.emit('reply', m.reply);
            }
        });
        s.on('error', () => {});
        s.on('close', () => {
            const was = !!this.sock;
            this.sock = null; this.connecting = false;
            if (was) this.emit('state', null);
            if (!this.closed) this.timer = setTimeout(() => this.connect(), RETRY_MS);
        });
    }

    send(q) {
        if (!this.sock) return false;
        this.sock.write(`${JSON.stringify(q)}\n`);
        return true;
    }

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        if (this.sock) this.sock.destroy();
    }
}

module.exports = { ToolClient, SOCKET };
