# Security model

## Assets

File contents and metadata, the room capability (pairing code), peer identity and session state,
TURN credentials, and the signaling infrastructure.

## Trust boundaries

| Party | What it can see |
|---|---|
| Signaling relay | A SHA-256-derived topic and encrypted signaling payloads. Not the pairing code, not file data, not file metadata. |
| STUN server | A connectivity probe. It sees an IP and port, never file data — there is no TURN relay in this project, so no server ever carries your bytes. |
| The paired device | Everything you send it. This is the party the approval step exists to control. |
| The app's own backend | There isn't one. The build is a static site. |

## The pairing code is the capability

A 12-symbol Crockford base32 code carries **60 bits of entropy**. It is used two ways and
transmitted neither time:

1. The signaling topic is `SHA-256(appId : "room" : code)`, truncated. A relay operator sees an
   opaque topic.
2. The code itself is the Trystero room password, which encrypts signaling payloads. Without the
   code you cannot complete a handshake even if you find the topic.

The code travels to the second device in the **URL fragment** (`#c=...`), which browsers never send
to a server, and the app strips it from the URL immediately after joining so it does not persist in
history or a screenshot.

**Guessing costs:** an attacker must compute the topic hash and subscribe to it on the right relay
during the room's lifetime. At 60 bits, exhausting the space is not feasible.

## What the code grants, and what it does not

Rooms hold up to 8 devices, and holding the code is what gets a device in — the same bearer model
as a share link. That is a deliberate choice for the product: people are meant to scan and start
downloading without anyone having to tap Allow.

Two things bound it:

1. **Every file needs the recipient's consent.** Nothing downloads automatically. Each incoming
   file shows its name, size and sender and waits for **Download** or **Decline**. A device in your
   room cannot push anything onto you silently.
2. **You can see and remove every device.** The roster is on screen the whole time; removing a
   device stops its transfers and blocks it from rejoining for the rest of the session.

For stricter setups, **Ask before a device joins** in settings restores per-device approval: until
you allow it, the only message accepted from that peer is `HELLO` (which carries the device name
for the prompt itself).

Be aware of the consequence of the default: anyone who obtains the code during the room's lifetime
can join and download whatever is currently shared. Treat a room code like a share link, and stop
sharing a file (or end the room) when you're done.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Room-code guessing | 60-bit code, hashed topic, encrypted signaling, room TTL, local join throttle (8 attempts/minute) |
| Code shared too widely | Per-file consent, a visible device roster, remove-and-block, and an optional per-device approval prompt |
| Unbounded room growth | Hard cap of 8 devices; further joins are turned away |
| Signaling / message flood | Token-bucket rate limiter per peer (200 msg/s, burst 400); excess is dropped |
| Oversized metadata | 16 KB control-message ceiling, enforced before parsing |
| Malformed protocol messages | Strict per-type schema validation; anything unrecognized is dropped, never coerced |
| Malicious filenames | NFC normalization, control-character and bidi-override stripping, Windows reserved-name rejection, byte-length truncation preserving the extension |
| Path traversal | Incoming names are reduced to a basename before any other processing; folder paths drop `..` and absolute prefixes segment by segment |
| Chunk-level lying | Every chunk's index and length is checked against what the offer promised; a mismatch fails the transfer as a protocol violation |
| Corrupted or tampered data | Chunk-tree SHA-256 verified before the file is handed over; a failed file is discarded, not saved |
| Browser resource exhaustion | Bounded in-flight window on the sender, bounded write queue with flow control on the receiver, per-tier storage caps, queue limits |
| Excessive file size | Configurable max file size, files per session, and queued bytes |
| Replay | Session, transfer and chunk identifiers plus state-machine validation; duplicate chunks are idempotent by design |
| Unwanted incoming file | Per-file Download/Decline before any byte is written |

## Transport security

WebRTC DataChannels are encrypted (DTLS/SCTP) by the browser. No custom transport is layered on
top, and the application-level hashing is for **integrity**, not confidentiality — it is not a
substitute for transport encryption.

## Known limitations

Be honest about these when deploying:

1. **No end-to-end identity.** There is no key exchange binding a device to an identity across
   sessions. Device names are self-reported and a malicious peer could spoof one.
2. **The code is a bearer token.** Anyone who obtains it during the room's lifetime can join and
   download what is shared. Per-file consent limits what can be pushed *to* you; it does not limit
   what a joiner can pull from what you have already shared.
3. **Public signaling relays.** The default configuration uses public Nostr relays. They see
   traffic patterns and topic hashes — timing and volume metadata, not content. Run your own relay
   if that matters to you.
4. **Rate limiting is client-side.** The join throttle protects a user's own session; it is not a
   server-enforced control. There is no server in this project to enforce one.
5. **No relay means some networks simply fail.** Symmetric NAT and strict firewalls cannot be
   traversed without TURN. This is a deliberate trade for having no infrastructure; the app reports
   it rather than routing your files through a third party.
6. **Peer-supplied metadata is displayed.** Filenames and device names are sanitized before display
   but are still attacker-chosen strings.
7. **No malware scanning.** Files are not inspected. That is a deliberate consequence of the
   architecture: nothing can scan what never reaches a server.

## Reporting

Open an issue for anything that lets a third party read file data, join a room without the code, or
write a file to a device that never pressed Download.
