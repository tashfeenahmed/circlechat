import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

// The repo has no jsdom — keep this node-env with hand-rolled fakes, matching
// the other src/lib tests. copyText only touches a documented slice of
// navigator/document, which is exactly what the fallback contract is.

interface FakeTextArea {
  value: string
  style: Record<string, string>
  readonly: string
  ariaHidden: string
  position: string
  selected: boolean
}

function installFakeDom(execCommandOk: boolean) {
  const attached: FakeTextArea[] = []
  const execCommand = vi.fn(() => execCommandOk)
  const doc = {
    execCommand,
    createElement: () => ({
      value: '',
      style: {},
      readonly: '',
      ariaHidden: '',
      position: '',
      selected: false,
      setAttribute(name: string, v: string) {
        if (name === 'readonly') this.readonly = v
        if (name === 'aria-hidden') this.ariaHidden = v
      },
      select() { this.selected = true },
    }),
    body: {
      appendChild: (el: FakeTextArea) => { attached.push(el) },
      removeChild: (el: FakeTextArea) => { attached.splice(attached.indexOf(el), 1) },
    },
  }
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true })
  return {
    execCommand,
    attached,
    restore: () => {
      if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc)
      else delete (globalThis as { document?: unknown }).document
    },
  }
}

function setClipboard(value: unknown) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true })
  return () => {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}

describe('copyText', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses the async clipboard when available', async () => {
    const dom = installFakeDom(true)
    const writeText = vi.fn(async () => {})
    const restoreNav = setClipboard({ clipboard: { writeText } })
    try {
      expect(await copyText('hello')).toBe(true)
      expect(writeText).toHaveBeenCalledWith('hello')
      expect(dom.execCommand).not.toHaveBeenCalled()
    } finally { restoreNav(); dom.restore() }
  })

  it('falls back to execCommand when navigator.clipboard is missing (plain HTTP)', async () => {
    const dom = installFakeDom(true)
    const restoreNav = setClipboard({})
    try {
      expect(await copyText('http cleartext')).toBe(true)
      expect(dom.execCommand).toHaveBeenCalledWith('copy')
      // The hidden textarea must not linger in the document.
      expect(dom.attached).toHaveLength(0)
    } finally { restoreNav(); dom.restore() }
  })

  it('falls back when the async clipboard rejects (permissions)', async () => {
    const dom = installFakeDom(true)
    const restoreNav = setClipboard({
      clipboard: { writeText: vi.fn(async () => { throw new Error('NotAllowed') }) },
    })
    try {
      expect(await copyText('x')).toBe(true)
      expect(dom.execCommand).toHaveBeenCalledWith('copy')
    } finally { restoreNav(); dom.restore() }
  })

  it('removes the textarea and reports failure when execCommand throws', async () => {
    const dom = installFakeDom(true)
    dom.execCommand.mockImplementation(() => { throw new Error('SecurityError') })
    const restoreNav = setClipboard({})
    try {
      expect(await copyText('x')).toBe(false)
      expect(dom.attached).toHaveLength(0)
    } finally { restoreNav(); dom.restore() }
  })

  it('hands focus back to the previously focused element', async () => {
    const dom = installFakeDom(true)
    const focus = vi.fn()
    ;(globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = { focus }
    const restoreNav = setClipboard({})
    try {
      expect(await copyText('x')).toBe(true)
      expect(focus).toHaveBeenCalled()
    } finally { restoreNav(); dom.restore() }
  })

  it('reports failure when both paths fail instead of lying', async () => {
    const dom = installFakeDom(false)
    const restoreNav = setClipboard({})
    try {
      expect(await copyText('x')).toBe(false)
    } finally { restoreNav(); dom.restore() }
  })
})
