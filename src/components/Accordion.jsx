// The settings column's accordions (rebuild plan step 4): one card per
// [key, title], a head button with icon, title, value and chevron, and a body
// that holds DOM nodes the tab still owns. One card is open at a time.
//
// Open state and head values live in a store (remixStore.js), not in React
// state, so layout.js and RemixTab keep calling openAccordion / setSummaries
// the same way as before. Bodies are host elements: React renders them empty
// and the nodes are appended once; a re-render never touches them.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createStore } from '../state/remixStore.js'

function Accordion({ store, id, title, iconHtml, chevronHtml, nodes }) {
  const { open, values } = useSyncExternalStore(store.subscribe, store.get)
  const headRef = useRef(null)
  const bodyRef = useRef(null)
  const isOpen = open === id
  const [text, on] = values[id] ?? ['', false]

  // The chevron is a direct child of the head button (CSS: .rx-acch > .rx-icon),
  // so it is appended once instead of rendered through a wrapper.
  useLayoutEffect(() => {
    headRef.current.insertAdjacentHTML('beforeend', chevronHtml)
  }, [chevronHtml])
  useLayoutEffect(() => {
    bodyRef.current.append(...nodes)
  }, [nodes])

  return (
    <div className="rx-acc" data-acc={id} data-open={String(isOpen)}>
      <button ref={headRef} className="rx-acch" type="button" aria-expanded={isOpen} onClick={() => store.set({ open: isOpen ? null : id })}>
        <span className="rx-acci" dangerouslySetInnerHTML={{ __html: iconHtml }} />
        <b>{title}</b>
        <span className={on ? 'rx-accv rx-on' : 'rx-accv'}>{text}</span>
      </button>
      <div ref={bodyRef} className="rx-accb" />
    </div>
  )
}

function Accordions({ store, list, bodies, icons, chevronHtml }) {
  return list.map(([id, title]) => (
    <Accordion key={id} store={store} id={id} title={title} iconHtml={icons[id]} chevronHtml={chevronHtml} nodes={bodies[id]} />
  ))
}

/**
 * Renders the cards into `side`, after whatever is already there.
 * @param {HTMLElement} side  the settings column (a flex column)
 * @param {[string, string][]} list  [key, title] per card
 * @param {Record<string, Node[]>} bodies  the nodes inside each card
 * @param {object} o
 * @param {(key: string) => string} o.iconFor  head icon markup per key
 * @param {string} o.chevronHtml
 * @param {() => void} [o.onOpenChange]  after the open card changed (canvases redraw)
 * @returns {{ elements: Map<string, HTMLElement>, openAccordion: (key: string|null) => void,
 *   setSummaries: (map: Record<string, [string, boolean]>) => void }}
 */
export function mountAccordions(side, list, bodies, { iconFor, chevronHtml, onOpenChange }) {
  const store = createStore({ open: null, values: {} })
  // display: contents keeps the cards direct flex children of the column.
  const host = side.ownerDocument.createElement('div')
  host.style.display = 'contents'
  side.appendChild(host)
  const icons = Object.fromEntries(list.map(([id]) => [id, iconFor(id)]))
  const root = createRoot(host)
  flushSync(() => root.render(<Accordions store={store} list={list} bodies={bodies} icons={icons} chevronHtml={chevronHtml} />))

  const elements = new Map(list.map(([id]) => [id, host.querySelector(`:scope > .rx-acc[data-acc="${id}"]`)]))
  let lastOpen = null
  store.subscribe(() => {
    if (store.get().open === lastOpen) return
    lastOpen = store.get().open
    onOpenChange?.()
  })

  return {
    elements,
    openAccordion(key) {
      flushSync(() => store.set({ open: key }))
    },
    // Head values ("100% · +1 st", "Off"); `on` lights the value in amber.
    setSummaries(map) {
      const old = store.get().values
      const values = { ...old }
      let changed = false
      for (const [key, [text, on]] of Object.entries(map)) {
        if (!elements.has(key) || (old[key]?.[0] === text && old[key]?.[1] === Boolean(on))) continue
        values[key] = [text, Boolean(on)]
        changed = true
      }
      if (changed) store.set({ values })
    }
  }
}
