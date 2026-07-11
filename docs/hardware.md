# Hardware identification

## Regulatory label

Full sticker data (regulatory plate + decoded QR) is in
[device-label.md](device-label.md).

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

The support QR on the unit encodes
`https://ms.phomemo.com/?mo=D30&mac=<MAC>&SN=<serial>` — see
[device-label.md](device-label.md). The `mac` parameter is the unit's
BLE MAC address: the QR alone hands you the exact address to target,
no discovery scan required.

## USB behavior

Confirmed: the USB-C port is charge-only. Nothing appears in `lsusb` when
plugged in. All communication with the host app happens over BLE.
