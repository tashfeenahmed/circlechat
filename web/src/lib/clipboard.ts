// Clipboard write with a legacy fallback.
//
// navigator.clipboard.writeText only exists in secure contexts, so a
// CircleChat deployment served over plain HTTP (the compose stack fronting
// the app on a LAN is exactly that) throws "Cannot read properties of
// undefined" on every copy on the page. Fall back to the deprecated
// textarea + execCommand path, which still works there. Returns whether the
// text actually made it to the clipboard so callers can show honest feedback
// instead of a silent no-op.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  let ta: HTMLTextAreaElement | undefined
  // select() moves focus into the hidden textarea; hand it back afterwards so
  // copying doesn't yank focus out of e.g. the composer.
  const prevFocus = document.activeElement as HTMLElement | null
  try {
    ta = document.createElement('textarea')
    ta.value = text
    // Keep it out of view and out of the scroll/aria tree.
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    ta.setAttribute('aria-hidden', 'true')
    document.body.appendChild(ta)
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // Always detach, even if execCommand threw.
    if (ta) {
      try { document.body.removeChild(ta) } catch { /* already gone */ }
    }
    try { prevFocus?.focus?.() } catch { /* ignore */ }
  }
}
