# Transfer Protocol v1

Trystero and WebRTC own transport and connectivity. This protocol owns transfer *semantics*:
offers, consent, flow control, checkpoints, resume, verification, and teardown.

A room holds up to 8 devices and the protocol is strictly **pairwise**: every message and every
chunk belongs to exactly one peer connection. A file shared with the room becomes one independent
transfer per device — its own offer, consent, queue position, checkpoints and resume state — so a
slow device never holds up the others. Transfer ids and `seq` values are only unique *within* one
peer, so both are routed by `(peerId, id)`.

Two channels are used, both over the same encrypted DataChannel:

- **`ctrl`** — JSON control messages
- **`chunk`** — binary frames carrying file bytes (never JSON, so payloads are not base64-inflated)

Every control message carries `v` (protocol version) and, where applicable, a transfer identifier.
Peers with incompatible major versions fail with a user-facing compatibility error rather than an
opaque WebRTC failure.

Source of truth: [`src/lib/protocol/`](../src/lib/protocol/).

---

## Chunk frame

A 16-byte big-endian header precedes every payload.

```
 0        1        2        4                8               12              16
 ┌────────┬────────┬────────┬───────────────┬───────────────┬───────────────┐
 │version │ flags  │  seq   │  chunkIndex   │  byteLength   │   reserved    │
 │  u8    │  u8    │  u16   │      u32      │      u32      │      u32      │
 └────────┴────────┴────────┴───────────────┴───────────────┴───────────────┘
                                    payload (byteLength bytes) →
```

`seq` is a compact per-session transfer id; the string `transferId` stays on the control channel.
`chunkIndex` makes every chunk self-locating, so the receiver writes at `chunkIndex × chunkSize`
and duplicates are harmless.

A frame is dropped — never guessed at — if it is shorter than the header, if `byteLength` exceeds
the negotiated chunk size, or if `byteLength` disagrees with the bytes actually received.

---

## Messages

| Message | Direction | Purpose |
|---|---|---|
| `HELLO` | both | Device name/kind, session id, resume support, and an optional `deviceId`. The only message accepted before a device is admitted. |
| `SESSION_APPROVE` | host → guest | Device trust decision. Only sent when per-device approval is switched on. |
| `SESSION_END` | both | `user` \| `expired` \| `blocked` \| `full`. |
| `PATH_NOTE` | both | How this device reads the shared connection. Cosmetic only — see [Agreeing on the path](#agreeing-on-the-path). |
| `TRANSFER_OFFER` | sender → receiver | File identity and chunking plan. |
| `TRANSFER_ACCEPT` | receiver → sender | Go-ahead, **from chunk N**. Sent on consent and again after a resume. |
| `TRANSFER_REJECT` | receiver → sender | `declined` \| `too-large` \| `no-storage` \| `busy`. |
| `TRANSFER_PAUSE` | both | User-initiated pause. |
| `TRANSFER_FLOW` | receiver → sender | Backpressure. Deliberately separate from a user pause so the two cannot cancel each other out. |
| `TRANSFER_RESUME` | sender → receiver | "Restarting — here is my file identity." |
| `TRANSFER_CHECKPOINT` | receiver → sender | Contiguous chunks **durably flushed**. |
| `TRANSFER_CANCEL` | both | `user` \| `error` \| `storage` \| `shutdown`. |
| `TRANSFER_COMPLETE` | sender → receiver | All chunks sent; here is the content hash. |
| `TRANSFER_VERIFY` | receiver → sender | The verification verdict. |
| `TRANSFER_ERROR` | both | Typed failure with optional detail. |

### Happy path

```
sender                                    receiver
  │                                          │
  ├── HELLO ────────────────────────────────►│
  │◄─────────────────────────────── HELLO ───┤   device is in the room
  │                                          │
  ├── TRANSFER_OFFER ───────────────────────►│   user sees name, size, storage advice
  │◄────────────── TRANSFER_ACCEPT from=0 ───┤   user taps Download; storage tier opened
  │                                          │
  ├── CHUNK 0 ──────────────────────────────►│   hashed, written at offset, verified length
  ├── CHUNK 1 ──────────────────────────────►│
  │◄──────── TRANSFER_CHECKPOINT chunks=N ───┤   only after a real flush
  ├── CHUNK … ──────────────────────────────►│
  │                                          │
  ├── TRANSFER_COMPLETE hash ───────────────►│   receiver recomputes the chunk-tree root
  │◄────────────── TRANSFER_VERIFY ok=true ──┤   file finalized only now
```

### Resume after a connection drop

```
        ✗ connection lost ✗
  ├── TRANSFER_RESUME {size, lastModified, chunkSize} ──►│
  │                                                      │  identity must match, or
  │                                                      │  TRANSFER_ERROR resume-mismatch
  │◄──────────── TRANSFER_ACCEPT from=<durable checkpoint>│
  ├── CHUNK <durable> … ────────────────────────────────►│
```

The sender resumes from the receiver's **durable** checkpoint, not from its own optimistic send
pointer. Anything above that checkpoint may not have reached disk, so it is discarded and
re-requested. Restarting from zero when a valid checkpoint exists is a protocol violation.

If the connection drops *after* every chunk was sent, the sender re-sends `TRANSFER_COMPLETE` on
reconnect and the receiver answers idempotently — with the stored verdict if it already verified,
or with a fresh `TRANSFER_ACCEPT` if chunks are actually missing.

---

## Invariants

1. **Duplicates are safe.** Repeated control messages and repeated chunks never corrupt the file.
   Chunks are written at computed offsets and de-duplicated by index.
2. **A checkpoint means durable.** It is only sent after `flush()`, because it is what a resume
   will trust.
3. **Incomplete is never complete.** The receiver finalizes a file only after every chunk is
   present, the content hash matches, and finalization succeeds. A failed file is discarded.
4. **Verification is not a point of no return.** `VERIFYING` can fall back to `RECONNECTING` or
   `TRANSFERRING`; a drop between "all sent" and the verdict must not strand the transfer.
5. **All peer input is untrusted.** Names, sizes, MIME types, indices, lengths, and paths are
   validated against the offer before use.
6. **No file is written without consent.** A device can offer, but only the recipient's
   `TRANSFER_ACCEPT` starts any writing.

---

## Transfer state machine

```
QUEUED ──► WAITING_FOR_ACCEPT ──► TRANSFERRING ──► VERIFYING ──► COMPLETED
                 │                    │  ▲            │
                 │                    ▼  │            │
                 │                  PAUSED            │
                 │                    │  ▲            │
                 ▼                    ▼  │            ▼
              REJECTED           RECONNECTING ◄───────┘
                 │                    │
                 └──────────► CANCELLED / FAILED
```

Terminal states are `COMPLETED`, `REJECTED`, `CANCELLED`, `FAILED`. `RECONNECTING` can return to
`WAITING_FOR_ACCEPT` (resume renegotiation), `TRANSFERRING`, or `VERIFYING`.

The table lives in [`src/lib/transfer/states.ts`](../src/lib/transfer/states.ts) and is enforced —
illegal transitions are refused, not logged and allowed.

---

## Flow control

Two independent mechanisms, both required:

**Sender.** Trystero waits on `bufferedamountlow` inside a single send, so awaiting one send is
already backpressure against unbounded DataChannel buffering. On top of that, at most
`MAX_IN_FLIGHT_CHUNKS` sends are outstanding at once, which keeps the pipeline full while capping
sender memory at `maxInFlight × chunkSize` regardless of file size.

**Receiver.** Writes are queued and awaited. If the queue exceeds 8 MB — disk slower than
network — the receiver raises `TRANSFER_FLOW{paused:true}` and lowers it once the queue drains
below 2 MB. This is separate from a user pause so neither can silently override the other.

---

## Agreeing on the path

ICE statistics are a local view, and the two ends of one connection routinely disagree about it.
The classic case: a phone that cannot resolve the other device's mDNS `.local` name learns its
address from an arriving STUN check instead, recording it as **peer-reflexive** rather than *host*.
Same link, same LAN, two different readings — one device saying "Local network" while the other
says "Internet".

So each device publishes its own reading as `PATH_NOTE` and both reconcile with the same rule:

- `relay` wins — those bytes really are going through a server.
- otherwise `local` beats `direct`, because `local` requires address evidence while `direct` only
  ever means *locality could not be shown*, never that the link is remote.

The rule is symmetric, so neither device can be the one that is wrong. The same reasoning applies
over time: ICE renominates candidate pairs after connecting, and a pair whose remote half becomes
server-reflexive reads as `direct` about two devices that never moved. A proven `local` is
therefore held until the peer disconnects, rather than being unproven by a later poll.

`PATH_NOTE` is cosmetic. Nothing routes, gates, or secures anything on it, and a peer that lies
about it changes a label and nothing else.

---

## Device identity

`HELLO` may carry a `deviceId` — a random value minted once per browser profile and kept in
`localStorage`. It exists because Trystero's peer id is regenerated on every page load, so two tabs
of one phone arrive as two unrelated devices: scan a code twice and the room fills with duplicates
of you, each offered its own copy of every file.

With it, a second connection from a device already in the room retires the first, and a peer that is
really another tab of *this* device is kept out of the roster entirely rather than disconnected —
two tabs each ending the other is a race with no winner.

It is optional. A browser with storage disabled, or an older build, sends none and simply does not
deduplicate.

---

## Versioning

`PROTOCOL_VERSION = 1`. A message with a version outside the compatible range is rejected with a
distinct `incompatible-version` reason, surfaced as "The other device is running a different
version — reload the page on both devices."

`PATH_NOTE` and `HELLO.deviceId` were both added without a version bump: a build that does not know
them drops the message as malformed and carries on, which is the intended degradation.
