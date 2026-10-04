# Transfer Protocol v1

Trystero and WebRTC own transport and connectivity. This protocol owns transfer *semantics*:
offers, consent, flow control, checkpoints, resume, verification, and teardown.

A room holds up to 8 devices and the protocol is strictly **pairwise**: every message and every
chunk belongs to exactly one peer connection. A file shared with the room becomes one independent
transfer per device — its own offer, consent, queue position, checkpoints and resume state — so a
slow device never holds up the others. Transfer ids and `seq` values are only unique *within* one
peer, so both are routed by `(peerId, id)`.

Each peer connection carries two data channels, both encrypted by the same DTLS session:

- **Trystero's channel**, with its **`ctrl`** action — JSON control messages.
- **`flit-bulk`** — file bytes as binary frames (never JSON, so payloads are not base64-inflated),
  one frame per message. Created on both ends with a fixed stream id (`negotiated`), so it needs no
  signaling. `TRANSFER_COMPLETE` travels here too, as a string, because it must arrive *behind*
  the chunks it summarizes; control and file data otherwise never wait on each other.

Each end says `flit-bulk:hello` on the bulk channel when it opens and answers a hello with
`flit-bulk:ack`; a side uses the channel for sending only once it has heard either. A peer on an
older build never answers, so after five seconds file data to it falls back to Trystero's
**`chunk`** action — one ordered path per connection either way, so completion can never overtake
the data. Chunks are accepted from both paths.

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

The chunk size is chosen by the sender per transfer and declared in the offer: at most 256 KiB, and
small enough that a chunk plus its header fits the connection's SCTP max-message-size — 255 KiB
between Chromium and Safari, which negotiate 256 KiB. The receiver holds every frame to the offer's
chunk size exactly.

---

## Messages

| Message | Direction | Purpose |
|---|---|---|
| `HELLO` | both | Device name/kind, session id, resume support, and an optional `deviceId`. The only message accepted before a device is admitted. |
| `SESSION_APPROVE` | host → guest | Device trust decision. Only sent when per-device approval is switched on. |
| `SESSION_END` | both | `user` \| `expired` \| `blocked` \| `full`. |
| `PATH_NOTE` | both | How this device reads the shared connection. Cosmetic only — see [Agreeing on the path](#agreeing-on-the-path). |
| `TEXT_SHARE` | both | A link or short note, capped at `maxTextLength`. Untrusted display text, handled like a filename. |
| `TRANSFER_OFFER` | sender → receiver | File identity and chunking plan, plus an optional `batchId` shared by everything dropped together. |
| `TRANSFER_ACCEPT` | receiver → sender | Go-ahead: **exactly these chunks** (`missing`, as ranges), or everything from `fromChunk`. Sent on consent, after a resume, at a gap, and when the sender goes quiet. |
| `TRANSFER_REJECT` | receiver → sender | `declined` \| `too-large` \| `no-storage` \| `busy`. |
| `TRANSFER_PAUSE` | both | User-initiated pause. |
| `TRANSFER_FLOW` | receiver → sender | Backpressure. Deliberately separate from a user pause so the two cannot cancel each other out. |
| `TRANSFER_RESUME` | sender → receiver | "Restarting — here is my file identity." |
| `TRANSFER_CHECKPOINT` | receiver → sender | Contiguous chunks **durably flushed**. |
| `TRANSFER_CANCEL` | both | `user` \| `error` \| `storage` \| `shutdown`. |
| `TRANSFER_COMPLETE` | sender → receiver | All chunks sent; here is the content hash. Sent behind the chunks, on the bulk channel. |
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
  │                                                      │  flush, then list what is absent
  │◄──── TRANSFER_ACCEPT from=<first gap> missing=[…] ───┤
  ├── CHUNK <exactly those> … ──────────────────────────►│
```

The receiver keeps every chunk it has written — it flushes first, which makes them as durable as a
checkpoint — and asks for exactly the ranges still absent, leaving out chunks already queued for
writing. The sender sends those and nothing else. At most 256 ranges are listed; past that the
last one runs to the end of the file, which may repeat a few chunks but never omits one.

`fromChunk` is still the first missing chunk, so an older sender that ignores `missing` resends
from there, which is correct because duplicates are harmless.

If the connection drops *after* every chunk was sent, the sender re-sends `TRANSFER_COMPLETE` on
reconnect and the receiver answers idempotently — with the stored verdict if it already verified,
or with a fresh `TRANSFER_ACCEPT` if chunks are actually missing. Gaps found at completion are
handled the same way: the receiver lists them, and only they are resent.

**Mid-stream, the sender trusts its own pipe.** A `TRANSFER_ACCEPT` that arrives while the sender
is still transferring — a receiver nudging a slow link — is planned without the chunks already
handed to the current connection or being sent right now: the data path is reliable and ordered,
so those are on their way. After a drop, and once `TRANSFER_COMPLETE` is out, the receiver's list
is authoritative and followed in full.

### An offer is not a transfer

A dropped connection interrupts nothing that has not been accepted. An offer stays
`WAITING_FOR_ACCEPT` across any number of blips, with no deadline, and the sender re-sends it when
the peer comes back — the answer, or the offer itself, may have been lost with the connection. A
receiver ignores an offer it already has, and answers again one it has already decided: the
rejection, cancellation, failure, verdict, or — if it accepted and the sender never heard — its
`TRANSFER_ACCEPT`.

### Asking again

A message can vanish with no error on either end: queued on a channel that then closed, or sent
while the peer was between connections. So every message that waits for an answer is repeated
after `TIMEOUTS.retryMs` (5 s) of silence, and each is idempotent at the far end:

| Waiting in | Repeats |
|---|---|
| sender `WAITING_FOR_ACCEPT`, offer never reached the link | `TRANSFER_OFFER` |
| sender `RECONNECTING`, peer reachable | `TRANSFER_RESUME`, or `TRANSFER_COMPLETE` if everything was out |
| sender `VERIFYING` | `TRANSFER_COMPLETE` |
| receiver `TRANSFERRING` with no chunk arriving (and no flow pause of its own), or `RECONNECTING` | `TRANSFER_ACCEPT` with what is missing |

The stall watchdog still bounds all of it. It only judges silence from the *peer*: while the
receiver is draining writes, hashing or saving — a multi-gigabyte `close()` can take a minute — it
does not count as a stall.

### Either end may restart it

A drop is routinely noticed by only one side. The other's peer connection can sit there looking
healthy for a long time, and if that side is the sender, it never sends `TRANSFER_RESUME` — so a
protocol where only the sender restarts a transfer deadlocks: both ends wait, and the one that
knows something is wrong is not allowed to say so.

So the end that noticed speaks. The sender sends `TRANSFER_RESUME` when it saw the drop; the
receiver sends `TRANSFER_ACCEPT{fromChunk, missing}` when it did. That message is the whole
negotiation — it is what the sender acts on either way — so no new message type is needed. If both
ends noticed, the sender simply receives it twice and plans from the second exactly as from the
first. Invariant 1 covers it.

A send that fails on a connection already given up on says nothing about the current one, and is
ignored: letting it count once knocked a freshly resumed transfer straight back into
`RECONNECTING`.

The reconnect window is measured from the **first** drop, not from the last sign of life. A peer
that flaps would otherwise refresh the clock on every reappearance and hold a transfer open forever
instead of failing it. The clock is cleared by a chunk actually arriving — asking to resume is not
evidence the link works, because the request itself can fail into a dead link.

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
   `TRANSFER_ACCEPT` starts any writing — and nothing completes without it either: a completion
   for a transfer the receiver never accepted is ignored.
7. **Silence is never a verdict.** Every message that expects an answer is asked again until it
   gets one or the transfer is given up on; nothing waits forever on a message that was lost.

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
`WAITING_FOR_ACCEPT` (resume renegotiation), `TRANSFERRING`, or `VERIFYING`. `PAUSED` can reach
`VERIFYING`: a pause stops new chunks, but every chunk may already have been on its way.

`WAITING_FOR_ACCEPT` never becomes `RECONNECTING` — see [An offer is not a
transfer](#an-offer-is-not-a-transfer).

The table lives in [`src/lib/transfer/states.ts`](../src/lib/transfer/states.ts) and is enforced —
illegal transitions are refused, not logged and allowed.

---

## Flow control

Two independent mechanisms, both required:

**Sender.** A send on the bulk channel waits while more than `BULK_HIGH_WATER` (4 MB) is queued
and resumes on `bufferedamountlow` at `BULK_LOW_WATER` (1 MB), so awaiting one send is already
backpressure — and one that cannot happen rejects rather than resolving with the data dropped. On
top of that, at most `MAX_IN_FLIGHT_CHUNKS` chunks are being read, hashed and sent at once, which
keeps the pipeline full while capping sender memory regardless of file size. The buffer can be
modest because control messages no longer queue behind it.

**Receiver.** Writes are queued and awaited; each chunk's hash is started as it arrives and runs
alongside the write. If the queue exceeds 8 MB — disk slower than network — the receiver raises
`TRANSFER_FLOW{paused:true}` and lowers it once the queue drains below 2 MB. This is separate from
a user pause so neither can silently override the other. A `TRANSFER_ACCEPT` lifts the sender's
flow pause, so the receiver re-raises its own right after one if the disk is still behind.

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

So were `TRANSFER_ACCEPT.missing`, the bulk channel and repeated offers. An older build ignores the
unknown field and resends from `fromChunk`; never answers the bulk channel's hello, so file data to
it stays on Trystero's channel; and ignores an offer it already has. Mixed versions interoperate in
both directions.
