import {useCallback, useEffect, useState, type FormEvent} from 'react'
import {CODE_SYMBOLS, formatCode, isValidCode, normalizeCode} from '../../lib/core/ids.ts'
import type {SessionSnapshot} from '../../lib/session/SessionManager.ts'
import {session} from '../store.ts'
import {useSheetSwipe} from '../sheetSwipe.ts'
import {useTheme, type Theme} from '../theme.ts'
import {Icon} from './common.tsx'

type Tab = 'about' | 'settings'

/**
 * Everything that isn't the room itself: how it works, the privacy claim,
 * settings, and code entry for devices that can't scan. Kept off the main
 * screen so the first thing a user sees is a QR code and a drop target.
 */
/** Must match the exit animation in styles.css. */
const EXIT_MS = 180

export function Sidebar({state, onClose}: {state: SessionSnapshot; onClose: () => void}) {
  const [tab, setTab] = useState<Tab>('settings')
  const [closing, setClosing] = useState(false)

  // The panel unmounts on close, so it has to play its exit animation first
  // and only then tell the parent to drop it.
  const dismiss = useCallback(() => {
    setClosing(true)
    setTimeout(onClose, EXIT_MS)
  }, [onClose])

  // Stop the page behind the sheet from scrolling, and close on Escape.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [dismiss])

  const panelRef = useSheetSwipe(dismiss)

  return (
    <div
      className={`sheet ${closing ? 'is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="About and settings"
    >
      <div className="sheet__backdrop" onClick={dismiss} />
      <div className="sheet__panel" ref={panelRef}>
        {/* Grab handle: on phones this panel is a bottom sheet. */}
        <div className="sheet__grip" aria-hidden="true" />
        <header className="sheet__header">
          <div className="segmented">
            <button
              type="button"
              className={`segmented__option ${tab === 'settings' ? 'is-active' : ''}`}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
            <button
              type="button"
              className={`segmented__option ${tab === 'about' ? 'is-active' : ''}`}
              onClick={() => setTab('about')}
            >
              About
            </button>
          </div>
          <button type="button" className="button button--icon" onClick={dismiss} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>

        {tab === 'settings' ? (
          <Settings state={state} onDismiss={dismiss} />
        ) : (
          <About state={state} />
        )}
      </div>
    </div>
  )
}

function About({state}: {state: SessionSnapshot}) {
  return (
    <div className="panel">
      {/* The only place the product is named — the room screen stays bare. */}
      <section className="wordmark">
        <h2>flit</h2>
        <p>
          <em>v.</em> to move swiftly and lightly from one place to another.
        </p>
      </section>

      <section>
        <h3>How it works</h3>
        <ol className="steps">
          <li>Your code is ready the moment you land here.</li>
          <li>Scan the code from another device — phone, laptop, anything with a browser.</li>
          <li>Drop files. Any connected device can download them.</li>
          <li>Close the tab and everything disappears.</li>
        </ol>
      </section>

      <section>
        <h3>Where your files go</h3>
        <p>
          Straight from one device to the other over an encrypted WebRTC connection. There is no
          upload step, no copy on a server, and no account. Files are chunked, streamed, and
          verified with SHA-256 on arrival — a file that doesn't match is discarded, not saved.
        </p>
        <p>
          Your code never reaches a server: what gets published is a hash of it, and the code
          itself is the key that encrypts the connection setup.
        </p>
      </section>

      <section>
        <h3>Codes</h3>
        <p>
          Nothing anywhere keeps a list of codes. Enter one somebody shared and you connect to
          their devices; enter one nobody is using and it simply becomes yours to share. Either
          way there is nothing to sign up for.
        </p>
      </section>

      <section>
        <h3>Drop first, connect later</h3>
        <p>
          Files are offered to <em>every</em> connected device, not to one in particular. Drop them
          now and anything that connects afterwards is offered them automatically.
        </p>
      </section>

      <section>
        <h3>When it can't connect</h3>
        <p>
          There is no relay server to fall back on, which is what keeps this free of infrastructure.
          On the same Wi-Fi it essentially always works. Across networks it usually works. A few
          networks — strict corporate firewalls, some captive Wi-Fi, certain mobile carriers — block
          direct connections outright, and there both devices should join the same network instead.
        </p>
      </section>

      <section>
        <h3>This browser</h3>
        <p>{describeStorage(state)}</p>
      </section>
    </div>
  )
}

function Settings({state, onDismiss}: {state: SessionSnapshot; onDismiss: () => void}) {
  const [theme, setTheme] = useTheme()
  const [name, setName] = useState(state.selfName)

  return (
    <div className="panel">
      <label className="field">
        <span className="field__label">Device name</span>
        <input
          className="field__input"
          name="deviceName"
          // Not an identity field, so keep password managers away from it.
          autoComplete="off"
          spellCheck={false}
          value={name}
          maxLength={32}
          onChange={event => setName(event.target.value)}
          onBlur={() => session.setDeviceName(name)}
        />
        <span className="field__hint">Shown to devices you connect with. Never sent to a server.</span>
      </label>

      <div className="field">
        <span className="field__label">Appearance</span>
        <div className="segmented">
          {(['system', 'light', 'dark'] as Theme[]).map(option => (
            <button
              key={option}
              type="button"
              className={`segmented__option ${theme === option ? 'is-active' : ''}`}
              onClick={() => setTheme(option)}
            >
              {option === 'light' && <Icon name="sun" size={14} />}
              {option === 'dark' && <Icon name="moon" size={14} />}
              {option[0]?.toUpperCase()}
              {option.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <JoinByCode onJoined={onDismiss} />

      <label className="toggle">
        <input
          type="checkbox"
          checked={state.requireApproval}
          onChange={event => session.setRequireApproval(event.target.checked)}
        />
        <span>
          <strong>Ask before a device joins</strong>
          <span>
            Off by default — holding the code is enough to join, and every file still needs your
            approval before it downloads. Turn on to confirm each device as well.
          </span>
        </span>
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={state.localOnly}
          onChange={event => session.setLocalOnly(event.target.checked)}
        />
        <span>
          <strong>Local network only</strong>
          <span>
            Refuses anything but a direct local connection. Applies next time you connect.
          </span>
        </span>
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={state.alwaysChooseLocation}
          onChange={event => session.setAlwaysChooseLocation(event.target.checked)}
        />
        <span>
          <strong>Always choose where to save</strong>
          <span>
            Asks for a location on every download. Off by default, where large files still get a
            picker and small ones go to your downloads.
          </span>
        </span>
      </label>

      {/* One action, not two. Disconnecting and starting over were separate
          steps with a dead-end screen between them, and the screen's only
          button was the step everybody took next. */}
      <div className="field">
        <button
          type="button"
          className="button button--danger"
          onClick={async () => {
            // Closed only on success: a failed restart leaves the error banner
            // on the room screen, and closing over it would hide the reason.
            if (await session.restart()) onDismiss()
          }}
        >
          Disconnect and start over
        </button>
        {/* "The code stops working" would overclaim: nobody owns a code here,
            and a device still in the old room stays there. What is true is that
            it no longer reaches this device. */}
        <span className="field__hint">
          Every device is disconnected and you move to a new code. The old one no longer reaches
          you.
        </span>
      </div>
    </div>
  )
}

/** For devices that can't scan — a laptop joining from a phone's code, say. */
function JoinByCode({onJoined}: {onJoined: () => void}) {
  // State is the code itself, not what was typed: normalized on the way in and
  // cut to length there. Keeping raw text and tidying it only for display meant
  // a thirteenth symbol lived on invisibly in the state, quietly failing
  // validation while the field looked complete.
  const [code, setCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [failed, setFailed] = useState(false)
  const valid = isValidCode(code)
  // Something was entered but it is not a whole code. Shown as a ring on the
  // field rather than a sentence below it: the field is where the problem is,
  // and the hint underneath is about what joining does, not about the code.
  const incomplete = code.length > 0 && !valid

  /**
   * Only a join that actually opened the room closes the sheet — the room
   * screen is what you want to see next, and leaving settings covering it
   * hides the very thing you just asked for. A failure keeps the sheet up,
   * because the error banner behind it would be invisible from here.
   */
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || joining) return
    setJoining(true)
    setFailed(false)
    if (await session.joinRoom(code)) {
      onJoined()
      return // Stays disabled through the exit animation.
    }
    setJoining(false)
    setFailed(true)
  }

  return (
    <form className="field" onSubmit={event => void submit(event)}>
      <span className="field__label">Join with a code</span>
      {/* The placeholder is a mask, not a sample code: a realistic-looking one
          reads as something you are supposed to type in.

          No maxLength: at 14 — the length of a formatted code — the browser
          truncated any paste carrying a stray space or quote, losing the last
          character before normalizeCode could strip the junk. The length limit
          belongs after normalizing, not before it, which is what the slice in
          onChange does. */}
      <input
        className={`field__input field__input--code ${incomplete ? 'field__input--partial' : ''}`}
        aria-invalid={incomplete || undefined}
        title={incomplete ? `${code.length} of ${CODE_SYMBOLS} symbols` : undefined}
        value={formatCode(code)}
        onChange={event => setCode(normalizeCode(event.target.value).slice(0, CODE_SYMBOLS))}
        placeholder="XXXX-XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
      />
      <button type="submit" className="button" disabled={!valid || joining}>
        {joining ? 'Joining…' : 'Join'}
      </button>
      <span className="field__hint">
        {failed
          ? "Couldn't open that room — check your connection and try again."
          : "Disconnects the devices you're connected to now."}
      </span>
    </form>
  )
}

function describeStorage(state: SessionSnapshot): string {
  switch (state.storage.best) {
    case 'filesystem':
      return 'Downloads stream straight to a location you pick — the best path for very large files.'
    case 'opfs':
      return 'Downloads stream to private browser storage, get verified, then land in your downloads. Large files never have to fit in memory.'
    default:
      return 'This browser lacks streaming storage, so incoming files are held in memory and capped at 512 MB.'
  }
}
