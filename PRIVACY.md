# Privacy & data retention

The product claim is deliberately narrow and literally true:

> **Your files are never uploaded anywhere.**

There is no backend in this project at all: the build is a static site. Two pieces of third-party
infrastructure are used purely to introduce the devices to each other — a public signaling relay
and public STUN servers. Neither ever carries file data, and there is no TURN relay, so no server
is capable of seeing your bytes even in transit.

## What happens to your data

| Data | Where it lives | How long |
|---|---|---|
| File contents | Only the devices in the room | Never touches a server |
| File metadata (name, size, type) | Sent to devices in the room over the encrypted channel | In memory, until the tab closes |
| Pairing code | The devices in the room | Until the room ends or expires |
| Signaling messages | Relay, encrypted with the pairing code | Relay-dependent; ephemeral |
| Partial received files | OPFS on the receiving device | Deleted on cancel/failure; purged at next app start |
| Transfer history | Nowhere | Not persisted |
| Device name | `localStorage` on your own device | Until you clear it |
| Theme preference | `localStorage` on your own device | Until you clear it |

## What no server ever receives

- File contents or chunks
- File names, sizes, or types
- The pairing code
- A permanent record of a room or transfer

## Telemetry

**None.** No analytics, no error reporting, no metrics endpoint. The only network requests the app
makes are to the signaling relay and to STUN.

If you deploy this at scale and need the operational metrics from the specification (connection
success rate, direct-vs-relay ratio, TURN bandwidth), add them explicitly and document them here.
Aggregate counters are sufficient; filenames, file sizes, and IP-linked records are not required to
operate the service and should not be collected.

## Retention windows for a deployment

There is no application server, so there are no application logs. The only records that can exist
are whatever your **static host** writes for serving the page (typically an access log with IP and
user agent) — configure that to your policy, and note that it records page visits, never transfers.

## Local data you can clear

Everything the app stores on your device is removable by clearing site data. Partial files in OPFS
are also purged automatically the next time you open the app.
