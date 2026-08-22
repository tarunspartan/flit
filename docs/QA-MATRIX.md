# Release QA matrix

A browser/platform combination is **Supported** only if it passes the applicable rows below. This
is a checklist to fill in per release, not a claim that can be made in advance.

Record the release, date, and exact browser versions tested.

```
Release: ______   Date: ______   Tester: ______
```

## Automated

Run first; these gate everything else.

```bash
npm run typecheck && npm test && npm run build
```

| Check | Status |
|---|---|
| 89 unit, session and end-to-end protocol tests pass | ☐ |
| Production build succeeds | ☐ |
| No type errors | ☐ |

## Network scenarios

| Scenario | Expected | Status |
|---|---|---|
| Same Wi-Fi (IPv4) | Connects; path shows **Direct P2P · Local network** | ☐ |
| Same Wi-Fi (IPv6-enabled network) | Still reads **Local network**, not Internet | ☐ |
| Different Wi-Fi networks | Connects directly, or fails with a clear explanation | ☐ |
| Wi-Fi → cellular | Connects, or fails with a clear explanation | ☐ |
| Cellular → Wi-Fi | Connects | ☐ |
| Direct connection impossible (symmetric NAT) | Clear failure explaining no relay exists, no hang | ☐ |
| Weak Wi-Fi | Transfer slows but completes | ☐ |
| Network switch mid-transfer | Reconnects and resumes from checkpoint, does not restart | ☐ |
| Local-network-only mode, same Wi-Fi | Connects | ☐ |
| Local-network-only mode, different networks | Fails visibly, never leaves the LAN | ☐ |

## Session and room

| Scenario | Expected | Status |
|---|---|---|
| Room opens with no interaction on load | QR visible immediately, no button pressed | ☐ |
| QR pairing | Phone camera opens the link and joins | ☐ |
| Manual code entry | Joins; dashes/case/spaces tolerated | ☐ |
| Invalid code | "That code doesn't look right" | ☐ |
| Repeated wrong codes | Throttled after 8 attempts in a minute | ☐ |
| Expired room (past its 6-hour lifetime) | "This room has expired" | ☐ |
| Third, fourth, fifth device joins | All admitted and listed | ☐ |
| Ninth device joins | Turned away once the room is full | ☐ |
| Two devices download the same file at once | Both complete independently | ☐ |
| Device joins *after* files were dropped | Offered them automatically | ☐ |
| Approval prompt (setting on) | Shows the joining device's name; Block works | ☐ |
| Removed device rejoins | Ignored for the rest of the session | ☐ |
| Peer closes tab | Other side shows reconnecting, then a clear end | ☐ |
| Browser refresh mid-session | Session ends cleanly, no zombie state | ☐ |
| Same device in two tabs | Second tab treated as a separate device | ☐ |
| End room | Both sides return to a clean state | ☐ |

## Files

| Scenario | Expected | Status |
|---|---|---|
| Empty file (0 bytes) | Transfers and verifies | ☐ |
| Tiny file (1 KB) | Transfers and verifies | ☐ |
| 1 GB file | Streams; memory stays flat | ☐ |
| **5 GB file (benchmark)** | Completes, verified, memory flat throughout | ☐ |
| 100+ files at once | Queued, one active at a time, order preserved | ☐ |
| Duplicate filenames | Second saved as `name (2).ext`, nothing overwritten | ☐ |
| Unicode filename | Preserved intact | ☐ |
| Very long filename (>255 bytes) | Truncated, extension preserved | ☐ |
| Filename with `../` or control characters | Reduced to a safe basename | ☐ |
| Stop sharing a file | Removed for everyone; in-flight transfers cancelled | ☐ |
| Paste an image | Queued as a file | ☐ |
| Reject an incoming file | Sender shows "Transfer declined" | ☐ |
| Cancel mid-transfer | Both sides stop; partial data discarded | ☐ |
| Cancel all | Every active transfer stops | ☐ |
| Retry after failure | Starts a fresh transfer in place | ☐ |
| Pause and resume | Resumes from where it stopped | ☐ |

## Integrity, storage, recovery

| Scenario | Expected | Status |
|---|---|---|
| Normal completion | "File verified" | ☐ |
| Corrupted chunk (inject) | Verification fails; **file is not saved** | ☐ |
| Receiver storage exhaustion | Clear "not enough storage", not a crash | ☐ |
| Storage warning before accept | Shown when the file is close to free space | ☐ |
| Finalization failure | Distinguished from a network failure in the message | ☐ |
| Disconnect at 50% | Resumes from checkpoint; does not restart | ☐ |
| Only one end notices the drop | The end that noticed restarts it; no deadlock | ☐ |
| Peer killed outright (no clean leave) | Other devices mark it away within a poll, not never | ☐ |
| Peer flaps repeatedly | Reconnect still gives up on time, measured from the first drop | ☐ |
| Disconnect during verification | Recovers; does not hang | ☐ |
| Sender file deleted mid-transfer | Clear "couldn't read the file" | ☐ |
| Save picker cancelled | Falls back to OPFS, transfer continues | ☐ |
| Auto-download blocked | "Save again" button works | ☐ |

## Mobile

| Scenario | Expected | Status |
|---|---|---|
| Screen locks mid-transfer | Pauses/reconnects; resumes on wake | ☐ |
| App backgrounded | Same as above; no false "complete" | ☐ |
| Browser killed by OS | Clean failure on return, partial data purged | ☐ |
| Low battery mode | Transfer continues or fails clearly | ☐ |
| Download permission denied | Clear message | ☐ |
| Portrait and landscape | Layout usable at 320 px wide | ☐ |

## Interface

| Scenario | Expected | Status |
|---|---|---|
| Light / dark / system themes | All readable; QR stays scannable | ☐ |
| Speed and ETA | Smoothed, no wild jumps, no misleading "0 seconds" | ☐ |
| Route, waiting | Faint dotted line, hollow far end, "Scan to connect" | ☐ |
| Route, connected locally | One unbroken green line and "Local network" | ☐ |
| Route, connected over the internet | Dashed line, no relay marker | ☐ |
| Route, relayed | Marker drawn mid-line, amber | ☐ |
| Route, peer dropped | Amber, hollow far end, "Reconnecting" | ☐ |
| Route, two or three devices | One leg each, every leg carrying its device name | ☐ |
| Route, legs line up | Endpoint dots form a column whatever the names are | ☐ |
| Route, four or more devices | Names fold away, header takes over the count, legs stay | ☐ |
| Route, a full room of eight | All eight legs drawn; no overflow at 320 px | ☐ |
| Route, links disagree | Counts them — "2 local · 1 internet" — never averages them | ☐ |
| Route, one device drops | That leg alone goes amber and hollow; the others keep their paths | ☐ |
| Route, leg order | Matches the roster the route opens | ☐ |
| Route, still classifying | Line only — no network claimed until one is known | ☐ |
| Route opens the device list | Tapping it shows the roster; not clickable with no devices | ☐ |
| Path badge per device | Matches that device's actual ICE candidate pair | ☐ |
| Path badge agrees on both devices | Same verdict on each end, and it does not flip to "Internet" seconds after settling on "Local network" | ☐ |
| Join by code vs by QR | Identical outcome; pasting a code with a stray space or quote still joins | ☐ |
| Install prompt | Offered only when the browser can install, gone once installed | ☐ |
| Share sheet (Android, installed) | flit appears; sharing a file opens it with the file queued | ☐ |
| Disconnect a device | Ends that session; re-entering the code reconnects | ☐ |
| Send a link | Arrives with sender name; Open only for http(s), never for `javascript:` | ☐ |
| Swipe the bottom sheet down | Closes on a real pull; a short pull snaps back | ☐ |
| Scroll inside the bottom sheet | Swiping never steals the scroll unless already at the top | ☐ |
| Cancel all | Appears past one transfer; stops both directions on both devices | ☐ |
| Share many files at once | Every file appears on the other device, not just the first | ☐ |
| Two separate drops | Arrive as two groups, not one; a late-joining device groups them the same way | ☐ |
| Sender-side grouping | The sending device shows the same two groups, not seven cards | ☐ |
| Newest first | The drop you just made is at the top of Sharing and Incoming | ☐ |
| Order inside a group | Files stay in the order picked; the running one does not move to the end | ☐ |
| Show / Hide alignment | Sits on the summary's line, and stays there once a transfer starts | ☐ |
| Download all | Starts one and queues the rest — never several at once | ☐ |
| Batch progress | Counts up "3 of 5 downloaded"; the group moves to Received when all are done | ☐ |
| Accept several downloads | One runs, the rest show Queued and start in turn | ☐ |
| Back a queued download out | "Not now" returns it to Download, and it can be taken later | ☐ |
| Cancel the running download | Stops it; the next queued file starts | ☐ |
| Receiving wording | The receiving device says "Receiving", not "Sending" | ☐ |
| Whole-window drag and drop | Overlay appears anywhere on the page | ☐ |
| Home screen | Route, code and one files control — no explanatory copy | ☐ |
| Files control | Says what pressing it does, and opens the picker | ☐ |
| Dashes appear only while dragging | Nothing is drawn as a drop target until a drag enters the page | ☐ |
| Transfer details panel | Protocol, connection, network, storage all correct | ☐ |
| Incoming above Sharing | Files sent to you sit above your own share list, in both themes | ☐ |
| Four devices in a room | Peer lines read Mac / Mac 2 / Mac 3 — no two devices share a label | ☐ |
| Four devices, phone width | No horizontal overflow; no state or percentage clipped | ☐ |
| Named legs, short names | Names reach the right edge — no reserved space they don't use | ☐ |
| Named legs, a 30-character name | Name ellipsises; the line keeps enough width to read its texture | ☐ |
| Multi-device shared card | One line per device, names and states in aligned columns | ☐ |
| Mixed states on one file | A cancelled line's state sits in the same column as a transferring one's | ☐ |
| Queued label | Reads "Queued" with no position number | ☐ |
| Download button | Outlined, not filled; hover fills with the soft tint | ☐ |
| Path on an offer | "Local network" or "Internet" shows before you accept, not only during | ☐ |
| Path while sending | Shown per device, so two peers on different networks read differently | ☐ |
| Path over mobile data | A phone off Wi-Fi reads "Internet" on both devices | ☐ |
| Path while connecting | No label at all until the path is known — never a guess | ☐ |
| Meta line on a phone | Size, sender and network all readable; no stray separator dots | ☐ |
| Meta line after a peer drops | Network label goes, and its separator dot goes with it | ☐ |
| Contrast, light theme | Meta text, status colours and the accent all pass AA | ☐ |
| Contrast, dark theme | Same, including the focus ring against adjacent borders | ☐ |
| Reduced motion | No width animation, no chevron spin, no button press travel, no travelling dashes on the route — and the route still reads as solid vs dashed | ☐ |
| Small download (Firefox) | No persistent-storage prompt for a file under 128 MB | ☐ |
| Large download (Firefox) | Prompts once for a file over 128 MB, and not again that page | ☐ |
| Refused persistence | Declining the prompt still lets the transfer run to completion | ☐ |
| Keyboard navigation | All actions reachable | ☐ |
| Reduced motion | Animations respect the preference | ☐ |

## Recovery

| Scenario | Expected | Status |
|---|---|---|
| Screen locks mid-transfer | Wake lock holds the screen on while bytes are moving | ☐ |
| Peer stuck on "Reconnecting" | "Reconnect now" appears and restores the room without losing the code | ☐ |
| One signaling relay refuses | Pairing still works; no lasting "Couldn't connect" banner | ☐ |
| Network switch with no peers | Silent for 10s, then "Reconnecting…", only then "Can't reach the internet" | ☐ |

## Browser results

| Browser | Version | Result | Notes |
|---|---|---|---|
| Chrome desktop | | ☐ | |
| Edge desktop | | ☐ | |
| Firefox desktop | | ☐ | |
| Safari macOS | | ☐ | |
| Safari iOS | | ☐ | |
| Chrome Android | | ☐ | |

## Target SLOs

Validate against real measurements before publishing these as commitments.

| Metric | Target | Measured |
|---|---|---|
| Peer connection success | ≥ 98% | |
| Transfer success | ≥ 99% | |
| Resume success (where supported) | ≥ 95% | |
| Median pairing time | < 5 s | |
| Median transfer start after connect | < 2 s | |
| Unbounded-memory incidents | 0 | |
