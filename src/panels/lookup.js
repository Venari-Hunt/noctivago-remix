// Looks up a panel's elements: map is { name: selector } or { name: { all: selector } } for a NodeList.
export function lookupEls(container, map) {
  const els = {}
  for (const [name, sel] of Object.entries(map)) {
    els[name] = typeof sel === 'string' ? container.querySelector(sel) : container.querySelectorAll(sel.all)
  }
  return els
}
