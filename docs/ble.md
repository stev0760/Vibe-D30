# Bluetooth LE findings

## Why classic pairing never worked

`bluetoothctl connect <mac>` initially failed with:

```
Failed to connect: org.bluez.Error.Failed br-connection-not-supported
```

The device's advertisement/EIR data includes a Class-of-Device value and
a classic "Serial Port Profile" (SPP, `00001101-...`) UUID, which makes
BlueZ (and presumably Android/iOS system Bluetooth UIs) attempt a classic
BR/EDR connection or pairing dance. This device is **LE-only** — it
doesn't actually implement SPP/BR-EDR, it just advertises those bits
(common firmware laziness on cheap BLE modules). This is almost
certainly why the printer "won't pair" from a phone's system Bluetooth
settings: the official app doesn't use system pairing at all, it opens a
direct LE GATT connection.

Fix: don't use system-level pairing / `bluetoothctl connect` at all.
Connect directly via a GATT/LE library (`bleak` in Python). On Linux,
first run `bluetoothctl remove <mac>` if a stale/confused device object
exists in the BlueZ cache from a prior classic-connect attempt.

## Advertisement data (`bluetoothctl info <mac>`)

```
Name: D30
Paired/Bonded/Trusted: yes (stale BlueZ cache from earlier attempts — not required)
UUID: Serial Port               (00001101-...)   <- misleading, not actually usable
UUID: Human Interface Device    (00001812-...)
UUID: Unknown                   (0000af30-...)
ManufacturerData 0x0000: xx xx xx xx xx xx            (device's own MAC, repeated)
ManufacturerData 0x7262: 32 32 78 78 11 22 33 44 55 66 aa bb 00 00
```

The `0x7262` manufacturer data looks like a template/placeholder pattern
(`11 22 33 44 55 66`, `aa bb`) — worth checking whether it's identical
across other Phomemo units, which would make it useful as a
vendor-fingerprint for scanning even when the name is changed.

## GATT table (via `scripts/gatt_enum.py` / bleak)

```
[Service] 00001800-0000-1000-8000-00805f9b34fb (Generic Access Profile)
  [Char] 00002a00-...  handle=2  props=read                        Device Name

[Service] 0000ff00-0000-1000-8000-00805f9b34fb (Vendor specific)
  [Char] 0000ff01-...  handle=5  props=read                        Vendor specific
  [Char] 0000ff02-...  handle=7  props=write-without-response,write Vendor specific
  [Char] 0000ff03-...  handle=9  props=notify                      Vendor specific
    [Desc] 00002902-...  handle=11   (Client Characteristic Configuration)
```

Working theory (typical of this class of cheap BLE thermal printer, e.g.
many "58mm BLE printer" modules and other Phomemo models):

- `ff02` = **TX** — write print commands/raster data here
- `ff03` = **RX** — subscribe (write `01 00` to the `2902` descriptor) to
  receive status/ack notifications
- `ff01` = some kind of read-once info/status characteristic (contents
  not yet inspected)

Not yet verified — needs a real captured print job to confirm command
framing, since we don't yet know if this uses a standard protocol
(ESC/POS-like) or a fully proprietary one (TSPL-like, common on Phomemo).

## Protocol: already reverse-engineered by others

The D30 is a popular budget printer, and its protocol has already been
sniffed and published by several independent projects. Cross-referencing
them against our own GATT scan confirms an exact match:

- [odensc/phomemo-d30-web-bluetooth](https://github.com/odensc/phomemo-d30-web-bluetooth) —
  uses Web Bluetooth, which can *only* speak GATT (never classic RFCOMM),
  and explicitly targets service `0000ff00-0000-1000-8000-00805f9b34fb`
  and characteristic `0000ff02-0000-1000-8000-00805f9b34fb` for writes —
  **byte-for-byte the same UUIDs we found by scanning our own unit.**
- [crabdancing/phomemo-d30](https://github.com/crabdancing/phomemo-d30) and
  [polskafan/phomemo_d30](https://github.com/polskafan/phomemo_d30) —
  Rust/Python implementations of the same protocol, but transported over
  classic Bluetooth RFCOMM sockets instead of BLE GATT. Since our unit's
  BlueZ `Device1.Connect()` fails with `br-connection-not-supported`, our
  unit likely doesn't answer on RFCOMM at all (or that code path differs
  by firmware revision) — but the underlying byte protocol is the same
  regardless of transport, and the GATT path (confirmed working via
  `bleak`) is what we should use.

### Command format (standard Epson ESC/POS, "GS v 0" raster image command)

Print header (10 bytes), sent as one write to `ff02`:

```
1b 40                   ESC @        — initialize/reset printer
1d 76 30 00             GS v 0 m=0   — "print raster bit image" command
<xL> <xH>               width in BYTES, little-endian 16-bit (e.g. 0x0c 0x00 = 12 bytes = 96px)
<yL> <yH>               height in ROWS, little-endian 16-bit (e.g. 0x40 0x01 = 320 rows)
```

Then the raster image data itself: 1 bit per pixel, MSB first, 1 = print
(dark) / 0 = blank, row-major, `width_bytes` bytes per row × `height`
rows. Sent in ~128-byte chunks (chunk size is a transport-friendliness
choice, not part of the protocol).

Footer (3 bytes), sent as the final write:

```
1b 64 00                ESC d 0      — print and feed 0 lines (finalize/cut point)
```

For the D30's 12mm tape: width is fixed at 96px (12 bytes/row); height
(label length) is however many px/rows the content needs. Some
implementations (crabdancing/polskafan) also send an extra proprietary
"magic" init sequence (`1f 11 ..` bytes) before the header — purpose
unconfirmed, possibly related to label-gap/calibration sensing on some
firmware revisions. The web-bluetooth implementation skips it entirely
and reportedly still works, so it may not be required for our unit.

**Confirmed working** — `scripts/print_test.py --live` successfully printed
a real "Hello World!" label. First attempt clipped because the font size
was a fixed fraction of the tape width and didn't account for text
*length*; fixed by auto-fitting the font size to both the width and
height of the available canvas (measure at a reference size, scale to
the more constraining dimension). Second attempt printed cleanly.

### Gotcha: BlueZ bearer selection — ride the auto-connect, don't fight it

**History note:** an earlier revision of this section recommended
`bluetoothctl disconnect` before connecting and `untrust` to stop BlueZ
auto-reconnecting the printer. That advice was wrong and caused a day of
breakage; kept here so nobody re-derives it.

The full picture (established against BlueZ 5.87 source,
`src/device.c` `dev_connect`/`select_conn_bearer`):

- The D30's advertisement carries classic-Bluetooth hints (Class of
  Device `0x100680`, SPP + HID UUIDs), so BlueZ types every fresh device
  record as **dual-bearer** even though the radio is LE-only.
- `Device1.Connect()` (which is what bleak calls) picks a bearer.
  For this device the stored record steers it to **BR/EDR**, which fails
  instantly with `br-connection-not-supported`. Two poisons observed in
  `/var/lib/bluetooth/<adapter>/<mac>/info`:
  - a `[LinkKey]` section with **no** `[LongTermKey]` — a classic key
    derived during LE pairing (CTKD); "the only bonded bearer" then wins
    bearer selection, and it's the bearer that doesn't exist;
  - `PreferredBearer=last-used` + `LastUsedBearer=bredr` — it remembers
    the *failed* classic attempt as last-used and keeps re-picking it.
- **But attaching to an already-connected device always works.** BlueZ
  auto-connects bonded+trusted HID-class peripherals over LE the moment
  they advertise. When that LE link is up, `Connect()` is a no-op attach:
  no bearer choice, no failure. This is why prints "mysteriously" worked
  for months — every success rode the auto-connected LE link; every
  failure was a fresh connect that chose BR/EDR.

So the stable configuration is: **leave the device bonded and trusted**,
and let the transport (d30/transport.py `_connect`) attach to the
existing LE link — it never disconnects first, and on the BR/EDR error it
waits a few seconds for BlueZ's auto-connect to win, then retries.
Discovery is not starved by the connection: bleak's BlueZ backend
returns cached/connected devices, not just live advertisements.

Related: KDE/GNOME may pop a "D30 is requesting access" authorization
dialog (BlueZ's input subsystem treats the fake HID UUID as a keyboard
trying to attach). **Answer "trust and authorize"** — while the dialog
sits unanswered, the device's pending security request wedges parts of
the ATT queue (observed: `ff01` reads still work, CCCD writes for
`ff03` notifications hang forever), which presents as prints hanging.

If a fresh setup ever hits persistent `br-connection-not-supported`
with no bond (so no auto-connect to ride), the storage-level fix is:
`sudo` edit `/var/lib/bluetooth/<adapter>/<mac>/info` — set
`PreferredBearer=le`, delete any `LastUsedBearer=` line and the whole
`[LinkKey]` section — then `sudo systemctl restart bluetooth`.

## Next step: capture real traffic

The fastest path to the actual byte protocol is capturing the official
Android app doing a real print job:

1. On the OnePlus 3T (LineageOS): Settings -> System -> Developer options
   -> enable **Bluetooth HCI snoop log**.
2. Open the Phomemo app, connect to the D30, print one simple label.
3. Pull the log (`btsnoop_hci.log`, path varies by Android
   version/vendor — LineageOS + likely-available root makes this easy to
   grab directly rather than needing `adb bugreport`).
4. Open in Wireshark, filter on the GATT writes to handle 7 (`ff02`) and
   read the notifications on handle 9 (`ff03`) to reconstruct the exact
   command bytes for a print job.
