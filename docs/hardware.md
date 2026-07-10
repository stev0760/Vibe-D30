# Hardware identification

## Regulatory label

Photographed clearly in `docs/images/IMG_9241.HEIC` (phone camera; earlier
webcam photos in this folder were too motion-blurred to read and are kept
only for reference).

```
Phomemo (R)
Smart Mini Label Maker
Model: D30   HVIN: D30B
Input: 5V === 2A
IC: 29002-D30A
FCC ID: 2ASRB-D30C
Made in China
```

Note: the user's initial recollection was "D60", but the physical label
is unambiguous — this unit is a **D30** (HVIN D30B). Phomemo sells several
visually similar mini label makers (D30, D35, D50, D60...); protocol
research should be scoped to D30 specifically, though these product lines
are known to share very similar (sometimes identical) BLE protocols.

## "Need Help? Scan Me" QR code

Decoded (via `zbarimg` on the sharp phone photo — the webcam photos were
too blurry for any decoder):

```
https://ms.phomemo.com/?mo=D30&mac=XXXXXXXXXXXX&SN=XXXXXXXXXXXXXXX
```

Query parameters:

- `mo=D30` — model, confirms the label
- `mac=XXXXXXXXXXXX` — the device's BLE MAC address, **no scanning
  required** to find it again
- `SN=XXXXXXXXXXXXXXX` — unit serial number

This single QR code is effectively worth more than the regulatory label:
it hands us the exact BLE address to target directly instead of relying
on discovery.

## USB behavior

Confirmed: the USB-C port is charge-only. Nothing appears in `lsusb` when
plugged in. All communication with the host app happens over BLE.
