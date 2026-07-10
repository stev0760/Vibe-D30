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

### Gotcha: BlueZ auto-reconnects this device, which breaks discovery

This device is `Bonded`/`Trusted` in BlueZ and advertises an
HID-class UUID (`00001812-...`). BlueZ auto-reconnects trusted/HID-class
peripherals as soon as they start advertising — but a connected
peripheral stops advertising, so a fresh discovery scan
(`BleakScanner.find_device_by_address`) can spuriously report "not
found" if BlueZ's auto-reconnect wins the race and grabs the connection
first. Symptom: `bluetoothctl info <mac>` shows `Connected: yes` even
though you never asked anything to connect.

Fixes, in order of preference:
1. `bluetoothctl disconnect <mac>` before running a script, so it's free
   to advertise and be found again.
2. If it keeps re-grabbing the connection between runs,
   `bluetoothctl untrust <mac>` once to stop BlueZ's auto-reconnect
   behavior entirely (safe — this device doesn't need OS-level
   pairing/trust for the app-layer BLE GATT protocol to work).

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
