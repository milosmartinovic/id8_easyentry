# Easy entry for iDrive 8 (BMW G87 M2)

Easy entry / exit for the driver's seat, installed from the
[mgu Store](https://github.com/robertnisipeanu/mgu-store):

- **Engine off, then the driver's door opens** → the seat moves **far back and up** (how far is set in the app),
  or, when the car offers no position control, to **seat memory 2**.
- **Engine start** → the seat goes to **seat memory 1**.

The app screen switches it on and off and sets the exit position, the travel, when it moves and memory 1 at
start.

> [!WARNING]
> **Not tested on a car yet.** The SOME/IP client (`seatctl`) and the whole chain (car state → decision → seat
> command) have been tested against a real vsomeip routing manager with a simulated car, and the tool installs
> with the Store's own deploy tool on a simulated iDrive 8 root. **Which SOME/IP service moves the seat on the
> G87 is not known yet**: it is found on the car on the app's *Seat and door setup* page (below). Test with the
> car parked and nobody behind the seat.

## Components

| Path | What |
|---|---|
| [`tools/mm-easy-entry`](tools/mm-easy-entry) | root service (`mm-easy-entry.service`, Node 8): watches the car state and the driver's door, decides when to move (`logic.js`), finds the seat / door services in the head unit's SOME/IP catalog (`catalog.js`), sends the commands through `seatctl` (`someip.js`) |
| [`native/seatctl`](native/seatctl) | `seatctl`, a small vsomeip client (C++): `call`, `send`, `sub`, `serve`. Built for the head unit (gcc 7, glibc 2.27), it imports only `vsomeip_v3::runtime::get()` from `libvsomeip3` |
| [`apps/mm_easy_entry`](apps/mm_easy_entry) | the iDrive 8 app "Easy entry" (HMI's own list widgets): settings, setup, test |

## When the seat moves

The car state is BMW's `statusConditionVehicle` (VehicleCondition `0x1531`, event `0x8002`, byte 5):
`10` FAHREN (drive-ready) counts as **engine on**. Drive-ready stays on while auto start-stop has stopped the
engine at a light, so the seat **never** moves at an auto-stop.

| Event | Action |
|---|---|
| drive-ready starts (to `10`) | memory 1 (setting *Memory 1 at engine start*) |
| drive-ready ends (`10` → `12` / `5` / …) | armed |
| …then the driver's door opens (*Move back when: Door opens*) | exit move, once |
| …or 1.5 s later (*Move back when: Engine off*, or no door signal set up) | exit move, once |

Never an exit while drive-ready or starting; at least 4 s between two moves; nothing at the tool's own start
unless the head unit booted with the engine start. *Exit position: Far back and up* sends the seat-position
command with *Back travel* and *Raise seat* (%); without a position command set up, or when it fails, it
recalls memory 2. *Exit position: Memory 2* always recalls memory 2.

**Backup with memory 2:** move the seat to the easy-exit position (all the way back and up), hold the door's
**M** button and press **2**. The app then needs only the seat memory command.

## Install

1. Install the Store (mgu-store README). It brings `mgu-deploy`, which the tool requires.
2. Put this folder in a GitHub repository of yours (e.g. `<you>/easy-entry`), or copy it to a USB stick as
   `mgu-repo/easy-entry/`.
3. In the Store: *Settings* → *Add source* → `<you>/easy-entry`, channel: the branch (`main`).
4. Install **Easy entry** (the app): the Store installs the **Easy entry** tool first. Restart the head unit
   (iDrive 8 installs at the next start).

## First setup on the car (Seat and door setup)

At start the tool reads `/etc/oap/someip/someip-interfaces.json`, the head unit's catalog of every SOME/IP
service, and lists candidates by name and data types:

- **Seat memory**: methods of seat interfaces named like *memory / recall / speicher / abruf*.
- **Seat position**: methods of seat interfaces named like *position / longitudinal / height / adjust /
  easy entry*.
- **Driver door**: one-byte members of door fields (*door / tür*), driver side first, with their "open" values.

For each candidate the tool builds the request payload from the argument types: a memory-slot enum becomes
`{slot:…}`, a seat / side enum picks the driver, a longitudinal / height argument takes `{back}` / `{up}`.

1. Open **Easy entry** → **Seat and door setup**. The status line shows how many services and candidates it found.
2. **Seat memory** → pick the first candidate. **Test** → **Memory 1** (engine off, parked). The seat should go to
   memory 1. If not, try the next candidate.
3. **Driver door** → pick a candidate; on the main page the status line then shows *door open / door closed*
   as you open and close it. If no candidate follows the door, leave it *Not set* and use *Move back when:
   Engine off*, or keep *Door opens* (without a door signal it moves 1.5 s after engine off).
4. **Seat position** (optional) → pick, then **Test** → **Move for exit**. If it does not move, leave it *Not set*:
   the exit uses memory 2.
5. **Save findings to USB**: writes `mm-easy-entry-discovery.json` (the candidates with their raw catalog
   entries), `mm-easy-entry-log.txt` and `someip-interfaces.json` to a USB stick. With those the payloads can be
   corrected by hand if a guess is wrong.

The picks are kept in `/var/opt/mm-easy-entry/settings.json` (`seat.memory`, `seat.position`, `seat.door`):
`svc`, `inst`, `method`, `major`, `tcp`, `payload` (hex with `{slot}`, `{slot:a,b,c}`, `{back}`, `{up}`,
`{back16}`, `{up16}`); the door: `svc`, `inst`, `major`, `group`, `event`, `byte`, `open` (and an optional `mask`).
An edited file takes effect when the service restarts (`systemctl restart mm-easy-entry`).

## Troubleshooting (SSH as root)

```sh
journalctl -u mm-easy-entry -f                     # what it sees and sends
S=/var/opt/mm-easy-entry/current/seatctl
$S sub 0x1531 1 1 2 0x8002                         # car state: byte 5 = 05 engine off, 0a engine on
$S call <svc> <inst> <method> <major> tcp <hex>    # one request by hand
```

`seatctl` prints `state registered` once the head unit's vsomeip routing manager has accepted it. If it never
does, the head unit's vsomeip build differs from the one it was checked against (below): the log says
`error vsomeip: not registered`.

## Development

```sh
sh test/run.sh                       # logic, catalog search, payloads, the app on a fake platform (any Node >= 8)
BIONIC=/opt/bionic native/seatctl/build.sh   # seatctl for the head unit (Ubuntu 18.04 userland, see build.sh)
INTEGRATION=1 sh test/run.sh         # + seatctl and the service against vsomeip 3.1.20 and a fake car
```

`native/seatctl/abi/libvsomeip3.so.3.symbols` is the export list of the iDrive 7 unit's
`libvsomeip3.so.3.1.34` (from robertnisipeanu/idrive-apps); `build.sh` checks the binary against it (loader
`/lib/ld-linux-x86-64.so.2`, glibc ≤ 2.27, libstdc++ ≤ 6.0.24). iDrive 8's library has not been compared;
`seatctl` uses the same import surface as IterioDev's `hmictl`, which runs on iDrive 8.

## License and credits

GPL-3.0-or-later (`LICENSE`). The vsomeip interface headers in `native/seatctl/third_party/vsomeip` are COVESA's
(MPL-2.0, their `LICENSE`); `native/seatctl/tools/abi.py` and the symbol list come from
[robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (GPL-3.0 / MPL-2.0). The app's
RHMI layout and start-up follow the Store app of
[robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) (GPL-3.0). The catalog format follows
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) (MIT). The car-state
signal's ids are those IterioDev documented for iDrive 8; no code from
[IterioDev/car-apps](https://github.com/IterioDev/car-apps) (PolyForm Strict) is used.

Unofficial, not affiliated with BMW. You modify your own head unit at your own risk.
