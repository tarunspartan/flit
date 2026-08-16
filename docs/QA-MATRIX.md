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
| 62 unit + end-to-end protocol tests pass | ☐ |
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
| Whole-window drag and drop | Overlay appears anywhere on the page | ☐ |
| Home screen | QR and drop target only — no explanatory copy | ☐ |
| Transfer details panel | Protocol, connection, network, storage all correct | ☐ |
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
