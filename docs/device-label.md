# Device label data

The two stickers on the underside of the unit.

## Support QR code

Caption: "Need Help? Scan Me". The QR encodes a support URL of the form:

```
https://ms.phomemo.com/?mo=D30&mac=<12 hex digits>&SN=<serial>
```

| Query parameter | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `mo`            | Model (`D30`)                                      |
| `mac`           | The unit's BLE MAC address, without separators     |
| `SN`            | Unit serial number                                 |

This is worth knowing: scanning your unit's QR hands you its exact BLE
MAC — useful for pinning a specific printer (`--address` / `D30_ADDRESS`)
without any Bluetooth discovery.

## Regulatory plate

| Field   | Value                    |
| ------- | ------------------------ |
| Brand   | Phomemo® (mushroom logo) |
| Product | Smart Mini Label Maker   |
| Model   | D30                      |
| HVIN    | D30B                     |
| Input   | 5V ⎓ 2A                  |
| IC      | 29002-D30A               |
| FCC ID  | 2ASRB-D30C               |
| Origin  | Made in China            |

Certification marks: FCC, BC (California battery-charger efficiency),
CE, WEEE.
