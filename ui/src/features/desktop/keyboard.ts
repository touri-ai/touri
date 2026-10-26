type KeyboardTarget = {
  sendKey: (keysym: number, code: string | null, down?: boolean) => void
  pasteText?: (text: string) => Promise<void>
}

const namedKeys: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Delete: 0xffff,
}
const symbolFor = (text: string): number => {
  if (text === "\n" || text === "\r") return namedKeys.Enter ?? 0xff0d
  if (text === "\t") return namedKeys.Tab ?? 0xff09
  const point = text.codePointAt(0) ?? 0
  return point <= 0xff ? point : 0x01000000 + point
}

/** A local textarea commits composed text once; physical shortcuts are sent separately. */
export const createDesktopKeyboard = (target: KeyboardTarget, mac: boolean) => {
  const held = new Map<string, number>()
  let composing = false
  let committedComposition: string | null = null
  let pending = Promise.resolve()
  let queued = 0
  let generation = 0
  const enqueue = (action: () => void | Promise<void>) => {
    const current = generation
    queued++
    pending = pending
      .then(() => (current === generation ? action() : undefined))
      .catch(() => undefined)
      .finally(() => queued--)
  }
  const sendKey = (symbol: number, down: boolean) => {
    if (queued) enqueue(() => target.sendKey(symbol, null, down))
    else target.sendKey(symbol, null, down)
  }
  const text = (value: string) => {
    const send = () => {
      for (const character of value) target.sendKey(symbolFor(character), null)
    }
    if (target.pasteText && [...value].some((character) => (character.codePointAt(0) ?? 0) > 0xff)) {
      release()
      enqueue(() => target.pasteText?.(value))
    } else if (queued) enqueue(send)
    else send()
  }
  const unhold = (code: string, immediate = false) => {
    const symbol = held.get(code)
    if (symbol === undefined) return
    held.delete(code)
    if (![...held.values()].includes(symbol)) {
      if (immediate) target.sendKey(symbol, null, false)
      else sendKey(symbol, false)
    }
  }
  const release = (immediate = false) => {
    for (const code of held.keys()) unhold(code, immediate)
  }
  return {
    release,
    paste: (value: string) => {
      if (!value) return pending
      release()
      if (target.pasteText) enqueue(() => target.pasteText?.(value))
      else text(value)

      return pending
    },
    reset: () => {
      generation++
      release(true)
      composing = false
      committedComposition = null
    },
    keydown: (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || composing || event.key === "Dead") return
      committedComposition = null
      let symbol = namedKeys[event.key]
      if (/^F([1-9]|1[0-2])$/.test(event.key)) symbol = 0xffbd + Number(event.key.slice(1))
      if (event.key === "Control" || (mac && event.key === "Meta")) symbol = 0xffe3
      else if (event.key === "Meta") symbol = 0xffeb
      else if (event.key === "Alt" && !mac) symbol = 0xffe9
      else if (event.key === "Shift") symbol = 0xffe1
      else if ((event.ctrlKey || event.metaKey || (!mac && event.altKey)) && [...event.key].length === 1)
        symbol = symbolFor(event.key)
      if (symbol === undefined) return
      event.preventDefault()
      const code = event.code || event.key
      if (held.has(code) || ![...held.values()].includes(symbol)) sendKey(symbol, true)
      held.set(code, symbol)
    },
    keyup: (event: KeyboardEvent) => {
      const key = event.code || event.key
      const symbol = held.get(key)
      if (symbol === undefined) return
      event.preventDefault()
      unhold(key)
      // macOS may omit keyup for the letter in a Command chord.
      if (mac && event.key === "Meta")
        for (const [code, heldSymbol] of held) if (heldSymbol < 0xffe1 || heldSymbol > 0xffee) unhold(code)
    },
    compositionstart: () => {
      release()
      composing = true
      committedComposition = null
    },
    compositionend: (value: string) => {
      if (!composing) return
      composing = false
      text(value)
      committedComposition = value
    },
    input: (value: string, isComposing: boolean) => {
      if (composing || isComposing) return false
      if (value !== committedComposition) text(value)
      committedComposition = null
      return true
    },
  }
}
