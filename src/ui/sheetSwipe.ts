import {useEffect, useRef} from 'react'

/** Far enough that it reads as a deliberate pull rather than a stray touch. */
const CLOSE_DISTANCE = 96
/** A short, fast flick should close too — px per millisecond. */
const FLICK_VELOCITY = 0.5
const FLICK_DISTANCE = 28
/** Must match the exit transition the sheet plays on close. */
const EXIT_MS = 180

/**
 * Swipe the bottom sheet down to close it.
 *
 * The whole problem is telling a close gesture apart from a scroll, and the
 * answer is where the touch starts:
 *
 * - on the grip or the header — nothing scrolls there, so it is always a drag;
 * - on the scrolling content — only when it is already at the top, because that
 *   is the one moment a downward swipe has nothing else to do.
 *
 * A drag that turns out to move upward is handed straight back, so flicking up
 * through a long settings panel never gets caught. Only the bottom-sheet layout
 * gets any of this; the desktop sheet slides in from the side and has nowhere
 * to be swiped to.
 */
export function useSheetSwipe(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = ref.current
    if (!panel || !window.matchMedia('(max-width: 560px)').matches) return

    let startY = 0
    let travelled = 0
    let startedAt = 0
    let dragging = false

    const release = () => {
      panel.style.transition = `transform ${EXIT_MS}ms ease`
      panel.style.transform = ''
      window.setTimeout(() => {
        panel.style.transition = ''
      }, EXIT_MS)
    }

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || event.touches.length > 1) return

      const scroller = panel.querySelector('.panel')
      const fromScroller = scroller?.contains(event.target as Node) ?? false
      if (fromScroller && scroller instanceof HTMLElement && scroller.scrollTop > 0) return

      dragging = true
      startY = touch.clientY
      travelled = 0
      startedAt = event.timeStamp
    }

    const onMove = (event: TouchEvent) => {
      if (!dragging) return
      const touch = event.touches[0]
      if (!touch) return

      travelled = touch.clientY - startY
      if (travelled <= 0) {
        // Upward after all — this was a scroll. Give it back untouched.
        dragging = false
        panel.style.transform = ''
        return
      }

      // Non-passive listener: this is what stops the page moving underneath.
      event.preventDefault()
      panel.style.transition = ''
      panel.style.transform = `translateY(${travelled}px)`
    }

    const onEnd = (event: TouchEvent) => {
      if (!dragging) return
      dragging = false

      const elapsed = Math.max(1, event.timeStamp - startedAt)
      const flicked = travelled / elapsed > FLICK_VELOCITY && travelled > FLICK_DISTANCE
      if (travelled <= CLOSE_DISTANCE && !flicked) {
        release()
        return
      }

      // Carry the panel the rest of the way down rather than letting it vanish;
      // the backdrop fade comes from the sheet's own closing class.
      panel.style.transition = `transform ${EXIT_MS}ms ease-in`
      panel.style.transform = 'translateY(100%)'
      onClose()
    }

    panel.addEventListener('touchstart', onStart, {passive: true})
    panel.addEventListener('touchmove', onMove, {passive: false})
    panel.addEventListener('touchend', onEnd)
    panel.addEventListener('touchcancel', onEnd)
    return () => {
      panel.removeEventListener('touchstart', onStart)
      panel.removeEventListener('touchmove', onMove)
      panel.removeEventListener('touchend', onEnd)
      panel.removeEventListener('touchcancel', onEnd)
    }
  }, [onClose])

  return ref
}
