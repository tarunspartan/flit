/**
 * Checks every signaling endpoint the app is pinned to — the nostr relays and
 * the MQTT brokers in src/lib/core/config.ts — the way pairing actually uses
 * them.
 *
 * A handshake proves nothing: plenty of relays accept a connection and then
 * refuse exactly what signaling needs (ephemeral event kinds, events without
 * proof of work). So each endpoint gets the real round trip: one connection
 * subscribes to a fresh topic, a second publishes to it, and the first must
 * receive the message. A failure is retried twice, fifteen seconds apart,
 * before it counts: public endpoints blip, and a daily check that cries wolf
 * gets ignored. One down for most of a minute is down.
 *
 *   npm run check:signaling
 *
 * Exits non-zero if any endpoint is dead, naming it, so a scheduled CI run
 * reports relay rot before users meet it as pairing that "sometimes" fails.
 */
import mqtt from 'mqtt'
import {createEvent, subscribe} from 'trystero/nostr'
import {MQTT_BROKER_URLS, RELAY_URLS} from '../src/lib/core/config.ts'

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

/** Subscribe with one client, publish with another, receive it. */
function mqttRoundTrip(url) {
  return new Promise(resolve => {
    const topic = `flit-health/${token()}`
    const clients = []
    const finish = settleOnce(resolve, () => clients.forEach(client => client.end(true)))
    const options = {reconnectPeriod: 0, connectTimeout: TIMEOUT_MS - 1000}

    const listener = mqtt.connect(url, options)
    clients.push(listener)
    listener.on('error', err => finish(false, err.message))
    listener.on('message', received => {
      if (received === topic) finish(true)
    })
    listener.on('connect', () =>
      listener.subscribe(topic, err => {
        if (err) return finish(false, `subscribe refused: ${err.message}`)
        const publisher = mqtt.connect(url, options)
        clients.push(publisher)
        publisher.on('error', err2 => finish(false, err2.message))
        publisher.on('connect', () => publisher.publish(topic, 'health-check'))
      })
    )
  })
}

async function check(network, url, roundTrip) {
  let result = await roundTrip(url)
  for (let attempt = 0; !result.ok && attempt < RETRIES; attempt++) {
    await sleep(RETRY_AFTER_MS)
    result = await roundTrip(url)
  }
  return {network, url, ...result}
}

const results = await Promise.all([
  ...RELAY_URLS.map(url => check('nostr', url, nostrRoundTrip)),
  ...MQTT_BROKER_URLS.map(url => check('mqtt', url, mqttRoundTrip))
])

const dead = results.filter(result => !result.ok)
for (const {network, url, ok, detail} of results) {
  console.log(`${ok ? 'ok  ' : 'DEAD'}  ${network.padEnd(5)}  ${url.padEnd(44)}  ${detail}`)
}

if (process.env.GITHUB_ACTIONS) {
  for (const {network, url, detail} of dead) {
    console.log(`::error title=Signaling endpoint down::${network} ${url} — ${detail}`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const {appendFileSync} = await import('node:fs')
    const rows = results.map(
      ({network, url, ok, detail}) => `| ${ok ? '✅' : '❌'} | ${network} | \`${url}\` | ${detail} |`
    )
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['## Signaling endpoints', '', '| | Network | Endpoint | Result |', '|---|---|---|---|', ...rows, ''].join('\n')
    )
  }
}

console.log(
  dead.length === 0
    ? `\nAll ${results.length} endpoints complete a signaling round trip.`
    : `\n${dead.length} of ${results.length} endpoints are down. Replace them in src/lib/core/config.ts.`
)
process.exit(dead.length === 0 ? 0 : 1)
