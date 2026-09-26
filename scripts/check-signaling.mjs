/**
 * Checks every nostr relay the app is pinned to (RELAY_URLS in
 * src/lib/core/config.ts) the way pairing actually uses them.
 *
 * A handshake proves nothing: plenty of relays accept a connection and then
 * refuse exactly what signaling needs (ephemeral event kinds, events without
 * proof of work). So each relay gets the real round trip: one socket subscribes
 * to a fresh topic, a second publishes a signed ephemeral event to it, and the
 * first must receive it. A failure is retried twice, fifteen seconds apart,
 * before it counts: public relays blip, and a scheduled check that cries wolf
 * gets ignored. A relay down for most of a minute is down.
 *
 *   npm run check:signaling
 *
 * Exits non-zero if any relay is dead, naming it, so a scheduled CI run
 * reports relay rot before users meet it as pairing that "sometimes" fails.
 */
import {createEvent, subscribe} from 'trystero/nostr'
import {RELAY_URLS} from '../src/lib/core/config.ts'

const TIMEOUT_MS = 10_000
const RETRIES = 2
const RETRY_AFTER_MS = 15_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const token = () => Math.random().toString(36).slice(2)

/** Settles once with the first outcome, closing whatever it was given to close. */
function settleOnce(resolve, cleanup) {
  let settled = false
  const started = Date.now()
  const timer = setTimeout(() => finish(false, 'no round trip within 10s'), TIMEOUT_MS)
  function finish(ok, detail) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    try {
      cleanup()
    } catch {
      // Already closed.
    }
    resolve({ok, detail: ok ? `${Date.now() - started} ms` : detail})
  }
  return finish
}

/** Subscribe on one socket, publish a signed ephemeral event on another, receive it. */
function nostrRoundTrip(url) {
  return new Promise(resolve => {
    const topic = `flit-health-${token()}`
    const subId = token()
    const sockets = []
    const finish = settleOnce(resolve, () => sockets.forEach(socket => socket.close()))
    let listening = false
    let publisherOpen = false
    const publish = async () => {
      if (!listening || !publisherOpen) return
      publisher.send(await createEvent(topic, 'health-check'))
    }

    const listener = new WebSocket(url)
    const publisher = new WebSocket(url)
    sockets.push(listener, publisher)
    listener.onerror = () => finish(false, 'connection failed')
    publisher.onerror = () => finish(false, 'connection failed')
    listener.onopen = () => listener.send(subscribe(subId, topic))
    listener.onmessage = event => {
      const [type, id] = JSON.parse(event.data)
      if (type === 'EOSE' && id === subId) {
        listening = true
        void publish()
      } else if (type === 'EVENT' && id === subId) {
        finish(true)
      } else if (type === 'CLOSED' && id === subId) {
        finish(false, 'subscription refused')
      }
    }
    publisher.onopen = () => {
      publisherOpen = true
      // Some relays never send EOSE for an empty subscription; do not wait on it forever.
      setTimeout(() => {
        listening = true
        void publish()
      }, 1500)
      void publish()
    }
    publisher.onmessage = event => {
      const [type, , accepted, reason] = JSON.parse(event.data)
      if (type === 'OK' && accepted === false) finish(false, `publish refused: ${String(reason).slice(0, 80)}`)
    }
  })
}

async function check(url) {
  let result = await nostrRoundTrip(url)
  for (let attempt = 0; !result.ok && attempt < RETRIES; attempt++) {
    await sleep(RETRY_AFTER_MS)
    result = await nostrRoundTrip(url)
  }
  return {url, ...result}
}

const results = await Promise.all(RELAY_URLS.map(check))

const dead = results.filter(result => !result.ok)
for (const {url, ok, detail} of results) {
  console.log(`${ok ? 'ok  ' : 'DEAD'}  ${url.padEnd(36)}  ${detail}`)
}

if (process.env.GITHUB_ACTIONS) {
  for (const {url, detail} of dead) {
    console.log(`::error title=Signaling relay down::${url} — ${detail}`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const {appendFileSync} = await import('node:fs')
    const rows = results.map(
      ({url, ok, detail}) => `| ${ok ? '✅' : '❌'} | \`${url}\` | ${detail} |`
    )
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['## Signaling relays', '', '| | Relay | Result |', '|---|---|---|', ...rows, ''].join('\n')
    )
  }
}

console.log(
  dead.length === 0
    ? `\nAll ${results.length} relays complete a signaling round trip.`
    : `\n${dead.length} of ${results.length} relays are down. Replace them in src/lib/core/config.ts.`
)
process.exit(dead.length === 0 ? 0 : 1)
