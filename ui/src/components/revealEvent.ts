/** Asks the conversation history to keep a just-shown result in view instead of following new content. */
export const REVEAL_EVENT = "touri:reveal"

export const requestReveal = (element: HTMLElement): void => {
  const event = new CustomEvent(REVEAL_EVENT, { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  // Outside the history, such as in an isolated card, the element reveals itself.
  if (!event.defaultPrevented) element.scrollIntoView?.({ block: "nearest" })
}
