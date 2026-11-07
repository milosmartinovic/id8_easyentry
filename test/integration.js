'use strict';
// Integration test (needs the bionic chroot with vsomeip and fake_provider, see native/seatctl/test):
// the service, seatctl, a fake car offering VehicleCondition and a seat memory method.
const fs = require('fs'), net = require('net'), path = require('path'), assert = require('assert');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync('/tmp/ee-int-');
process.env.EASY_ENTRY_DATA = tmp;
const { Service } = require('../tools/mm-easy-entry/easyentry');
fs.writeFileSync(path.join(tmp, 's.json'), JSON.stringify({ exitDelayMs: 3000 }));
const prov = spawn('/bin/sh', ['-c', 'env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LD_LIBRARY_PATH=/usr/local/lib VSOMEIP_CONFIGURATION=/build/t/vsomeip-test.json chroot /opt/bionic /bin/bash -c "rm -rf /tmp/vsomeip*; cd /build/t && ./fake_provider"'], { stdio: ['ignore', 'ignore', 'pipe'] });
let provLog = ''; prov.stderr.on('data', (d) => { provLog += d; });
setTimeout(() => {
    const svc = new Service({ settings: path.join(tmp, 's.json'), discovery: path.join(tmp, 'd.json'), ctl: path.join(tmp, 'ctl.sock'),
        seatctl: path.join(__dirname, 'seatctl-chroot.sh'), catalog: path.join(__dirname, 'fake-catalog.json') });
    svc.start();
    setTimeout(() => {
        const c = net.connect(path.join(tmp, 'ctl.sock'));
        c.write(JSON.stringify({ op: 'pick', kind: 'memory', i: 0 }) + '\n');
        c.write(JSON.stringify({ op: 'set', settings: { back: 80 } }) + '\n');
        let last; c.setEncoding('utf8'); let b = '';
        c.on('data', (d) => { b += d; let n; while ((n = b.indexOf('\n')) >= 0) { const m = JSON.parse(b.slice(0, n)); b = b.slice(n + 1); if (m.state) last = m.state; } });
        setTimeout(() => {
            svc.bus.stop(); prov.kill();
            const methods = (provLog.match(/method 12 len 2/g) || []).length;
            console.log('provider:', provLog.trim().split('\n').join(' | '));
            console.log('last:', JSON.stringify(last.last), 'car:', JSON.stringify(last.car));
            assert.strictEqual(last.seat.memory.label, 'vehicle.SeatComfortTest.requestSeatMemoryRecall');
            assert.strictEqual(last.settings.back, 80);
            assert.strictEqual(methods, 2, 'memory 1 at start, memory 2 at exit');
            assert.ok(/memory 2: sent/.test(last.last.text), last.last.text);
            assert.strictEqual(last.car.cond, 5);
            const log = fs.readFileSync(path.join(tmp, 'log.txt'), 'utf8').split('\n').filter((l) => /entry|exit/.test(l)).slice(-4);
            console.log(log.join('\n'));
            console.log('integration ok'); process.exit(0);
        }, 12000);
    }, 500);
}, 800);
