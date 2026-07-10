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
