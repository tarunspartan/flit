# flit

> **flit** *(v.)* — to move swiftly and lightly from one place to another.

**A temporary bridge between your devices.** Open the site and a room is already there. Scan the
code from another device, drag files onto the page, and they go straight from one device to the
other over WebRTC — never uploaded to a server.

```
OPEN → SCAN → DROP → DOWNLOAD → VERIFY → DONE → DISAPPEAR
```

No sign-up, no click to get started, and **no backend to run** — not even a TURN relay.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173, also served on your LAN IP
```

A room opens by itself. Scan the QR code from another device, or open the printed **Network** URL
on a device on the same Wi-Fi — `npm run dev` binds to `0.0.0.0` precisely so a phone can reach it.

> Browsers only expose the WebRTC and storage APIs on a secure context. `localhost` counts as
> secure; a bare LAN IP does not. For phone testing either use a tunnel that terminates TLS
> (`cloudflared tunnel --url http://localhost:5173`, `ngrok http 5173`) or deploy the built site.

```bash
npm run build        # typecheck + production bundle in dist/
npm test             # 147 unit, session, transport and end-to-end protocol tests
npm run typecheck
```

The build output is a static site with no server side at all. Any static host works — GitHub Pages,
Netlify, Cloudflare Pages, an S3 bucket. There is nothing to deploy alongside it and nothing to
keep running.

---

## What it does

| | |
|---|---|
| **Pairing** | Zero clicks — a room exists on load. QR-first, with a 12-symbol code as fallback. |
| **Group rooms** | Up to 8 devices. Everyone can send, everyone can download, all at once. |
| **Share first, connect later** | Files belong to the *room*. Drop them now; devices that join afterwards are offered them automatically. |
| **Transport** | WebRTC via [Trystero](https://github.com/dmotz/trystero), with file bytes on a data channel of their own. Direct local or direct internet, classified from the real ICE candidate pair and drawn as a line across the top of the screen. |
| **Large files** | Streamed in chunks of up to 256 KiB — each sized to travel as one message — with backpressure on both ends. A 5 GB file never has to fit in memory on either device. |
| **Integrity** | Every chunk is SHA-256'd; the file hash is the hash of those digests. A file that fails verification is never handed to the user. |
| **Resume** | After a connection drop the receiver says exactly which chunks it still lacks, and only those are sent again — not everything after the first gap, and never from zero. |
| **Text and links** | Send a URL or a note to the room without wrapping it in a file. Only a message that is entirely one http(s) URL becomes clickable. |
| **Privacy** | No account, no upload, no file storage, no telemetry. The pairing code never reaches a server. |
| **Installable** | A PWA. Once installed on Chromium — Android, ChromeOS, Windows — it registers as a share target, so *Share → flit* opens the app with the file already queued. Not macOS or iOS: neither wires a web app into the system share sheet. |

### What a transfer costs

Every transfer says where its bytes are travelling — **Local network** or **Internet** — next to the
size and the sender, on both the receiving and the sending device. It is there before you accept,
which is the moment it matters: a 2 GB file over your own Wi-Fi is free, and the same file over a
phone's data plan is not.

`direct` and `relay` both read as "Internet". They differ in whether a server is in the middle,
which is a trust question and is what the connection badge in the device list answers; for deciding
whether to spend your data allowance the distinction changes nothing. Nothing is shown at all while
the path is still unknown — a guess about someone's data plan is worse than saying nothing.

On the sending side the label sits on each device's own line, because a laptop on the same Wi-Fi and
a phone on mobile data are the same file costing two very different things.

### Telling devices apart

Device names are guessed from the user agent, so a room with two MacBooks would show two peers both
called "Mac". Past two devices that stops being cosmetic — which one is at 40%, which one Disconnect
will end, and who sent a note all become unanswerable — so a colliding name is numbered on arrival:
`Mac`, `Mac 2`, `Mac 3`. The number is assigned once and never reshuffled, because renumbering the
survivors when a device leaves would rename a peer mid-transfer.

Numbering is per screen: each device numbers the peers *it* can see, and never itself, so the same
laptop can be "Mac 2" on one screen and "Mac" on another. That is fine for the question the label
actually answers, which is always local. Renaming a device in settings is the fix when you need one
name everyone agrees on.

### Deliberately not built

Cloud storage, permanent file hosting, public links, server-side scanning or previews, accounts,
server-side transfer history — and **no TURN relay**, which is what keeps the project free of
infrastructure. See [No relay, on purpose](#no-relay-on-purpose).

---

## Architecture

The UI never sees SDP, ICE candidates, DataChannels, or Trystero. Everything below
`SessionManager` is replaceable.

```
                          UI (React)
                              │
                       SessionManager          room lifecycle · devices · expiry
                        │           │
                 RoomManager   TransferManager  shared files · per-device queues
                                    │
                  ┌─────────────────┼──────────────────┐
              Protocol        FlowController      ResumeManager
           (messages,          (bounded            (checkpoints,
            validation)         in-flight)          renegotiation)
                  └─────────────────┼──────────────────┘
                            IntegrityVerifier
                                    │
                          Transport (interface)
                                    │
                  TrysteroTransport ── BulkChannel (file data)
                                    │
                            WebRTC · STUN
```

```
src/lib/
├── core/        events · ids · errors · config (every tunable limit)
├── protocol/    wire messages · strict validation · binary framing
├── transport/   Transport interface · Trystero adapter (nostr + MQTT) · bulk data channel · ICE path classifier
├── integrity/   chunk-tree hashing
├── storage/     three receiver tiers + capacity checks
├── transfer/    send/receive halves · per-device queues · flow control · states
├── session/     session lifecycle · room codes · device roster
└── utils/       filename sanitizing · formatting · speed smoothing
```

Resume logic lives inside `SendTransfer`/`ReceiveTransfer` rather than a separate `ResumeManager`
class — checkpoint state is meaningless apart from the transfer that owns it.

### Two adapters, or it isn't a seam

Nothing above `Transport` knows about SDP, ICE or Trystero — but for a while that was a claim
rather than a fact, because `SessionManager` built its own `TrysteroTransport` inside itself. One
implementation means the interface is never actually exercised as an interface, and it meant the
largest file in the repo, holding room lifetime, peer trust, reconnect and signaling health, could
only be run against real WebRTC and live relays. So it was never run at all.

`SessionManager` now takes a factory, defaulting to the real one, and
[`MemoryTransport`](src/lib/transport/MemoryTransport.ts) is the second adapter: two of them on one
`MemoryNetwork` genuinely deliver to each other, so two sessions hold a real conversation in a test
with no network. Control messages are round-tripped through JSON and delivery is asynchronous,
because that is what the wire does.

This is the shape `TransferManager` already had — it takes `linkFor` rather than building links,
`PeerLink` has had two adapters from the start, and that is exactly why the transfer protocol is
the best-tested code here. The same move, one seam up.

`signalingReady()` moved onto the `Transport` interface as part of it. It was being called on the
concrete class, which is what forced the field to be typed to `TrysteroTransport` and kept the
whole module off its own seam.

### Files belong to the room, not to a device

Dropping a file registers it as *shared*. `TransferManager` then creates one `SendTransfer` per
device — each with its own consent, checkpoints and resume state — and re-runs that for every
device that joins later. One device downloading slowly never blocks another.

Every shared file is offered as soon as it is dropped, not one at a time. An offer is metadata, so
holding the rest back until the first finished meant a device could see only the first file with no
sign the others existed.

A large download gets the connection to itself. Accepting several marks the rest **Queued**: five
large downloads sharing one connection all crawl and none of them finishes, whereas serially the
first file is usable while the rest arrive, and an interruption costs one part-file instead of five.
Small files (8 MB and under) are the exception and run up to four at a time — for a photo, the round
trips around the bytes cost more than the bytes, so one at a time left the link idle most of the
time. Order is kept either way: a small file never jumps a large one queued ahead of it.

Files dropped in one action share a `batchId` and are shown as one group on **both** devices —
"5 files · 15 MB" with **Download all** on the receiving side, folded until you expand it, so a big
drop costs one row rather than five cards in either direction. The group counts up — "3 of 5
downloaded" — on a hairline along the card's edge, so a transfer starting never changes the height
of the summary or moves the controls out of line with it. Opening a group lists its files one line
each; a file shared on its own still gets the full card, with the per-device breakdown and details.
Grouping comes from the sender, so a device joining an hour later sees the same batches instead of
one clump of everything at once.

The newest drop is at the top of each list, and files inside a group stay in the order they were
picked — including the one currently downloading, which does not jump position when it starts.

A queued file offers **Not now** rather than Cancel. Cancelling is terminal, and a queued file has
not started — leaving the queue puts its Download button back, so you can accept everything, change
your mind, and take only the two you actually wanted.

### File data has its own channel

Trystero finds devices and keeps the connection up; it does not carry the files. Each connection
gets a second data channel, created on both ends with a fixed id (`negotiated`, so it needs no
signaling), and every chunk travels on it as exactly one message — chunks are sized to the
max-message-size the two browsers negotiated, 255 KiB between Chromium and Safari.

Trystero's own channel splits every message into 16 KiB pieces, which cost two full copies per chunk
and a reassembly on the far side, and queued control messages — Pause, Cancel, a new offer — behind
megabytes of file data. Worse, its send gives up silently: a channel that does not drain within ten
seconds, or closes mid-message, *resolves* the send with the message half gone. Chunks and
completions could vanish while both ends believed them delivered. On the dedicated channel a send
either reaches the channel or throws, and the one control message whose order relative to the chunks
matters — `TRANSFER_COMPLETE` — travels on it behind them.

An older build has no such channel, so each end says hello on it first and only uses it once the other
answers; with a peer that never does, file data falls back to Trystero's channel. Mixed versions in
one room keep working in both directions.

### Receiver storage tiers

Chosen automatically per transfer, best first:

1. **User-chosen location** (File System Access) — streams straight to disk, one write, no quota.
   Used for files ≥ 256 MB, or always if you enable it in settings.
2. **OPFS** — written off the main thread via one shared worker with sync access handles, verified,
   then handed to your downloads. Bounded memory at any file size. Each page keeps its files in a
   folder of its own, held by a Web Lock while the page lives, so a second tab or a reload never
   deletes another page's files; folders nobody holds are cleared at startup.
3. **Memory** — last resort for browsers with neither. Hard-capped at 512 MB; larger transfers are
   declined rather than crashing the tab.

OPFS is evictable: a browser under storage pressure may drop a partial file, taking the durable
checkpoint with it, so a resume has nothing left to resume from. Receiving a file of 128 MB or more
into OPFS therefore asks for persistent storage first — once per page, never on load, and never for
a smaller file, because Firefox shows a permission prompt for it and one guarding a transfer that
finishes in two seconds costs more than the eviction it prevents. The request is not awaited: the
browser's answer changes nothing about how the bytes are written, so it can never delay or fail a
transfer.

### Integrity: `sha256-chunktree-v1`

Web Crypto has no streaming digest, and buffering a 5 GB file to hash it would defeat the streaming
design. So each chunk is hashed with native SHA-256 and the file hash is
`SHA-256(algorithm | size | chunkSize | totalChunks | digest₀ ‖ digest₁ ‖ … ‖ digestₙ)`.

That is incremental, survives a reconnect, binds the file's structure, and stays fast enough not to
become the throughput bottleneck.

---

## No relay, on purpose

There is no TURN server, and there is no configuration for one. That is the trade-off that makes
this maintenance-free forever: nothing to pay for, nothing to keep alive, nothing that could
quietly end up in your file path.

What remains is public STUN, which only tells a browser how its own address looks from the outside.
It never carries file data, needs no account, and costs nothing.

"Relay" here means TURN — a server your *files* pass through. Introducing two devices still needs a
signaling relay to carry the offer and answer, which is what the pinned nostr relays below do. Those
see an opaque topic and ciphertext, never a byte of a file.

The honest consequence:

| Situation | Result |
|---|---|
| Same Wi-Fi or hotspot, with internet | Essentially always works, at full local speed |
| Same Wi-Fi or hotspot, **no internet at all** | **Cannot pair** — see below |
| Different networks, typical home/mobile NAT | Usually works |
| Symmetric NAT, strict corporate firewall, some captive Wi-Fi | **Cannot connect** — the app says so and suggests putting both devices on the same network |

A relay would paper over that last row by routing your files through someone's server. This project
would rather tell you the truth and stay free.

The no-internet row is about *introductions*, not bytes. Two devices on one offline hotspot can
reach each other directly — and once connected, files never leave the network — but a browser cannot
listen for another device, so something has to carry the first offer and answer between them, and
here that is a signaling relay or broker. Without internet access nothing can. The only serverless way
around it in a browser is to carry that exchange by hand, as QR codes each device scans from the
other; that is not built.

## Configuration

There is nothing to configure to run it.

### Limits

All abuse and resource limits live in [`src/lib/core/config.ts`](src/lib/core/config.ts) —
max file size, files per session, room TTLs, message rates, checkpoint intervals, chunk size, and
the in-flight window. Change them there rather than hunting through the code.

### Signaling relays

Devices are introduced over two independent networks, because the public servers that do it are
run by other people and disappear without notice.

- **Nostr relays** (`RELAY_URLS`) — the primary. Every device announces and listens here from the
  start.
- **MQTT brokers** (`MQTT_BROKER_URLS`) — the backup: public brokers run by EMQX, HiveMQ and the
  Eclipse Foundation, so they fail for reasons unrelated to volunteer nostr relays. Every device
  *listens* here, which costs three sockets and no connections. A device only starts *announcing*
  here when nostr has not delivered someone it expects — a guest that has met nobody six seconds
  after joining, or a device that dropped and has not come back. A listener wakes when it hears an
  announcement, so the two meet over MQTT with no extra step for anyone. The MQTT client is loaded
  after the page is up and never delays it.

A device reachable over both networks has two connections and is still one device: one carries the
traffic and the other waits on standby, taking over if the first dies.

`RELAY_URLS` in the same file pins the nostr relays. This is worth
knowing about, because the default behaviour is a trap: Trystero picks five relays from its list of
47 by shuffling them with a seed derived from the app id — so the choice is fixed for the whole
app, not per room. Four of the five it picked for this app id were dead (503, 530, 502, and a
refused connection), leaving pairing to ride on a single relay and fail whenever that one relay was
busy.

Each pinned relay is checked with the round trip signaling depends on, not just a handshake: one
socket subscribes to a topic, a second publishes a signed ephemeral event to it — the kind Trystero
sends — and the first has to receive it. Plenty of relays answer a handshake and then refuse exactly
that (ephemeral kinds blocked, proof of work demanded). The brokers get the same test with MQTT.

That check runs every day: [`.github/workflows/signaling-health.yml`](.github/workflows/signaling-health.yml)
round-trips every pinned relay and broker and fails — which notifies you — when one is down for
most of a minute, naming it. Run it by hand any time:

```bash
npm run check:signaling
```

GitHub pauses scheduled workflows after 60 days without repository activity; if the job stops
appearing, re-enable it from the Actions tab.

### Deploying

`npm run build` emits a static site. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
typechecks, tests, builds, and publishes to GitHub Pages on every push to `master`.

A project site is served from `/<repo>/`, so the build needs its prefix baked in — the workflow
passes it via `BASE_PATH` from `actions/configure-pages`. Building by hand without that variable
targets the root, which is what dev, preview, and a custom domain all want.

The Pages **Source** must be set to *GitHub Actions* rather than *Deploy from a branch*; nothing is
committed back to the repo.

---

## Browser support

Requires WebRTC data channels. Large-file receiving additionally needs OPFS or the File System
Access API.

| Browser | Transfer | Large-file receiving |
|---|---|---|
| Chrome / Edge (desktop) | ✅ | ✅ streams to a location you pick |
| Firefox (desktop) | ✅ | ✅ OPFS → download |
| Safari 16.4+ (macOS) | ✅ | ✅ OPFS → download |
| Safari (iOS 16.4+) | ✅ | ✅ OPFS → download |
| Chrome (Android) | ✅ | ✅ OPFS → download |

The support matrix is a claim that has to be *earned per release* — see
[docs/QA-MATRIX.md](docs/QA-MATRIX.md) for the scenarios a browser must pass before it is listed
as supported.

**Mobile reality:** a backgrounded or screen-locked mobile browser can be suspended or killed by
the OS, which pauses or drops the transfer. The app reconnects and resumes from the last checkpoint
when the tab comes back, but it will not claim a transfer continues while the screen is off.

---

## Design

### The route

The first thing on the screen is the line to every device you are connected to:

```
MAC
 │───────────────────────────────────────●  THINKPAD
 ●╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌●  PIXEL 8
 │╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌◆╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌●  IPHONE
              1 LOCAL · 1 INTERNET · 1 RELAYED
```

Each leg's texture *is* that link's classification, so there is no legend to learn:

| Leg | Meaning |
|---|---|
| Unbroken | Your own network. Nothing is in the middle of it, so nothing interrupts it. |
| Dashed | The internet, still directly between the two devices. |
| Dashed with a marker mid-line | A relay — a server in your file's path, drawn in the middle of the path. |
| Faint dots, hollow far end | Nobody there yet, or a device that has dropped. |

A room holds eight devices and [the protocol is strictly pairwise](docs/PROTOCOL.md), so from your
device's seat the shape is a hub with independent spokes — never a chain or a shared bus. One leg
per device is the only honest drawing of that, and it is what makes the case that matters visible
rather than checkable: **the laptop on your Wi-Fi and the phone on mobile data**, where the same
file costs two very different things. A single line averaging them could only ever have been a
guess.

Which way a file travels is this project's trust signal, and it used to be a badge inside a popover
nobody opens. Putting it at the top answers "where is my file going?" before you have sent
anything, and tapping it opens the roster.

Two things fold as the room fills. Up to three devices, each leg carries its name and the header
stays quiet; past three the names move into the roster and the header takes over the count, because
the names are what stop fitting — the legs still do. And when the links disagree, the line beneath
them counts rather than summarises: `2 local · 1 internet` is the shape of the difference, where
"several devices" was only ever the fact of one.

### Colour

One accent token drives the primary action, the progress fill, incoming chips, focus rings and
links. It is a deep ocean blue at OKLCH hue 245, and it sits 87° clear of the nearest status colour
(`--ok` at 158°) — green, amber and red are already spoken for by `--ok`, `--warn`/`--relay` and
`--danger`, so an accent in one of those would make "do this" and "this finished" the same colour.

The neutrals are that same hue 245 held under 0.03 chroma rather than being true greys, so the
ground the app sits on is a desaturated version of its own accent. Enough to feel on a full-screen
field, not enough to read as a blue theme.

The primary action is outlined rather than filled — border and label in the accent, soft tint on
hover. A solid block of accent sat next to a progress bar in the same colour, and the two competed
for the same glance.

Every foreground clears **WCAG 2.1 AA** against the darkest surface it can land on: 4.5:1 for text.
Both palettes were derived rather than picked — hue and chroma held, lightness moved — and every
pairing was then measured against the previous values so a recut could not quietly cost contrast.
The two faintest text tiers gained from the last one: `--text-faint` went from 4.19 to 4.71 on dark
`--surface-2`, the tightest pairing in the app. Hairline borders sit below the 3:1 of SC 1.4.11 and
always have; the controls they outline are identified by their labels rather than their edges.

### Type

Three roles, and only one of them is prose.

| Role | Face | Where |
|---|---|---|
| Prose | System sans | Filenames, buttons, banners, settings — anything that is language |
| Readout | `--mono`, tabular | Sizes, speeds, states, meta lines — so a column of cards has its numbers in a column too |
| Label | `--mono`, uppercase, tracked | Section eyebrows, path badges, the route's ends and state |

The split is the point: a filename is a name, `879 KB` is a measurement, and `SHARING 3` is an
instrument label. The pairing code is the specimen the rest is tuned against. No webfonts —
[PRIVACY.md](PRIVACY.md) promises the only requests this app makes are to the signaling relay and
STUN, and the app has to work offline once installed. A font CDN would break both.

### Motion

One animation: the route's dashes travel while there is genuinely something in progress — looking
for a device, or looking for one again — and stop the moment a device lands. Movement means "still
searching" rather than "this app has animations".

`prefers-reduced-motion: reduce` removes movement and keeps colour: the dashes stop travelling but
keep their pattern, which is what carries the meaning; the progress bar stops animating its width;
chevrons stop rotating; buttons keep their hover colour but lose the 1px press travel; and the sheet
and popover fade in place instead of travelling. Nothing is removed outright — an element that
simply appeared with no transition would be its own kind of jarring.

## Security & privacy

- [SECURITY.md](SECURITY.md) — threat model, what the pairing code protects, known limitations
- [PRIVACY.md](PRIVACY.md) — the data-retention contract
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the wire protocol

The short version: the pairing code is the room capability. It is never sent to any server — the
signaling relay only ever sees a SHA-256 of it, and the code doubles as the key that encrypts
signaling payloads. Holding the code is what gets a device into the room, and **every individual
file still needs the recipient to press Download** before a byte of it moves. If you want a prompt
per device as well, turn on *Ask before a device joins* in settings.

This app collects **no telemetry**. The operational metrics the spec describes are deliberately not
implemented rather than implemented and quietly phoned home; add them behind an explicit,
documented opt-in if you deploy this at scale.

---

## Testing

```bash
npm test
```

`tests/units.test.ts` covers the parts where a bug is silent: filename sanitizing (path traversal,
bidi overrides, reserved names, byte-length truncation), code normalization, frame decoding,
protocol validation, chunk-tree hashing, the state machine, flow control, and speed smoothing.

`tests/session.test.ts` runs real `SessionManager`s against an in-memory `Transport`: room
lifetime, the roster, link classification, the reconnect window, and the signaling health states.
That file exists because `Transport` has a second adapter — see [Two adapters, or it isn't a
seam](#two-adapters-or-it-isnt-a-seam). Timers are faked throughout, so a six-hour room expiry is
a millisecond test.

`tests/transfer.test.ts` runs a real `SendTransfer` against a real `ReceiveTransfer` over a
simulated link — control messages are JSON round-tripped through the validator and chunks are
encoded and decoded as binary frames, so it exercises the actual protocol. It covers a clean
multi-chunk transfer, an empty file, a mid-transfer disconnect that must resume rather than
restart, duplicate chunks, a corrupted chunk that must fail verification and withhold the file,
a chunk that contradicts the offer, rejection, a resume with a mismatched file, and cancellation —
and, under **recovery**, every way a message or a connection can go missing: a blip before anyone
accepts, a lost go-ahead, a lost completion, a lost decision, a single lost chunk, a file that
vanishes mid-send, a completion delivered twice, and a save slower than the stall window.

`tests/session.test.ts` also covers when a device looks harder for a missing peer — a guest that
has met nobody, a device that dropped — and that a host simply waiting, or a room where everyone is
present, never does. The connection bookkeeping behind "two connections, one device" is covered in
`tests/units.test.ts`.

`tests/manager.test.ts` drives `TransferManager` against recording links: chunks sized to the
link's message limit, small downloads side by side, a large one alone, order kept between them, and
a repeated offer answered rather than listed twice. `tests/bulk.test.ts` covers the file-data
channel against a fake channel pair: the hello handshake and the fallback, backpressure, and a
closed channel refusing a send rather than pretending it went.

Real bugs caught during development, now regression-covered: illegal characters being stripped
before the path-separator split (which defeated basename extraction); a stranded transfer when a
resume rewound the send pointer while the pump was draining; same-Wi-Fi connections reported as
"Internet" because the classifier only accepted private addresses, while home networks hand out
globally-routable IPv6; the two ends of one link disagreeing about that classification because a
peer-reflexive candidate was read as NAT traversal; and the badge later flipping to "Internet" on
its own when ICE renominated the candidate pair.

A later round, each found by reproducing it first: an offer that nobody had accepted yet failing two
minutes after any network blip, and an empty file "completing" on one without consent; Trystero
resolving a send whose message it had half dropped; the control-message rate limit silently
swallowing every offer past the 400th; "Reconnect now" wiping everything this device had shared; a
deleted source file reported as a lost connection after a two-minute wait; a slow multi-gigabyte
save failed as a stall after the sender had already been told it succeeded; one overlapping
completion finalizing — and downloading — a file twice; one lost chunk resending the rest of the
file; a stale failure from a dead connection knocking a resumed transfer back into reconnecting; an
unaccepted offer holding the screen awake for the room's whole lifetime; opening a second tab
deleting the first tab's received files; and two devices on one IPv6 Wi-Fi labelled "Internet"
because ICE picked the reflexive form of an address that has no NAT in front of it.

---

## License

MIT
