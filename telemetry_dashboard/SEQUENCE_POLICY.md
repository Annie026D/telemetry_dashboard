# Publisher sequence policy

Sequence-loss accounting is keyed by receive channel, sender IPv4 address, and
the first numeric field found in this order: `seq`, `sequence`,
`packet_counter`. No captured packet in the checked-in logs currently contains
one of these fields, so width, reset, and wrap behavior cannot be asserted from
repository evidence.

| Configured channel | Confirmed field | Width/reset/wrap policy |
|---|---|---|
| `lcu_transport` | None confirmed | Publisher specification required |
| `joystick` | None confirmed | Publisher specification required |
| `button_led` | None confirmed | Publisher specification required |
| `tracker_telemetry` | None confirmed | Publisher specification required |
| `external_track` | None confirmed | Publisher specification required |
| `tracker_publish` | None confirmed | Publisher specification required |
| `imu` | Synthetic load packets use `sequence` | Test counter is unbounded JSON integer and starts at zero; production policy unknown |
| `maindisplay` | None confirmed | Publisher specification required |
| `wcs_control_console` | None confirmed | Publisher specification required |
| `cce_gateway` | None confirmed | Publisher specification required |
| `advantec_driver` | None confirmed | Publisher specification required |
| `drive_wcs` | None confirmed | Publisher specification required |

For a confirmed stream, equal values increment the duplicate counter, a lower
value increments out-of-order, and a forward jump greater than one increments
the gap counter by the missing count. The implementation does not currently
treat a backward jump as wraparound or restart because doing so without the
publisher's counter width and reset contract would hide real disorder.

Multiple publishers sharing an IPv4 address and channel cannot be separated
unless their payload or transport metadata supplies a stable publisher ID.
