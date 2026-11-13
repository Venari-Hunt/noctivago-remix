// The DOM side of timing markers: the Marker button (icon only, the preview
// row is narrow) and chip list in the
// preview module, ticks on the progress bar, and the marker popover (rename,
// five colors, Go to, Delete). All markup follows the approved mock.
import { MARKER_COLORS, markerColor, sortedMarkers } from '../domain/markers.js'
import { MARKER_ICON_SVG } from './markerLayer.js'
import { icon } from './icons.js'
import { escapeHtml } from '../domain/html.js'

export function formatMarkerTime(t) {
  const m = Math.floor(t / 60)
  return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`
}

// Builds the Marker button (in the play row, Sound mode only) and the chip
// row under the progress bar. Returns the two elements.
export function mountMarkerUi(root, { onAdd, onGo, onDelete }) {
  const doc = root.ownerDocument
  const end = root.querySelector('#rx-prow-end')
  const seek = root.querySelector('.rx-pseek')
  if (!end || !seek) return null

  const button = doc.createElement('button')
  button.id = 'editor-add-marker'
  button.type = 'button'
  button.className = 'rx-i rx-marker-btn rx-only-sound'
  button.title = 'Marker: add one at the playhead (Ctrl+M)'
  button.setAttribute('aria-label', 'Add a marker at the playhead')
  button.innerHTML = MARKER_ICON_SVG
  button.addEventListener('click', onAdd)
  end.prepend(button)

  const list = doc.createElement('div')
  list.id = 'rx-mlist'
  list.className = 'rx-mlist rx-only-sound'
  list.setAttribute('aria-label', 'Markers')
  list.addEventListener('click', (evt) => {
    const del = evt.target.closest('[data-del]')
    if (del) return onDelete(Number(del.dataset.del))
    const go = evt.target.closest('[data-go]')
    if (go) onGo(Number(go.dataset.go))
  })
  seek.after(list)
  return { button, list }
}

export function flashMarkerButton(button) {
  if (!button) return
  button.classList.remove('rx-flash')
  void button.offsetWidth
  button.classList.add('rx-flash')
}

// The chip row: one chip per marker, nearest-first by time.
export function renderMarkerChips(list, markers, selectedId) {
  if (!list) return
  if (!markers.length) {
    list.innerHTML = '<span class="rx-mnone">No markers yet. Press Ctrl+M while it plays.</span>'
    return
  }
  list.innerHTML = sortedMarkers(markers)
    .map(
      (m) =>
        `<span class="rx-mchip${m.id === selectedId ? ' rx-sel' : ''}" style="--mc:${markerColor(m)}" data-go="${m.id}" title="Move the playhead here"><i></i>${escapeHtml(m.name)} <span>${formatMarkerTime(m.time)}</span><button type="button" class="rx-mx" data-del="${m.id}" title="Delete marker" aria-label="Delete ${escapeHtml(m.name)}">${icon('x', 12)}</button></span>`
    )
    .join('')
}

// Ticks on the progress bar (it spans the trimmed region): a marker outside
// the trim has no place on it.
export function renderProgressTicks(progress, markers, loopStart, loopEnd) {
  if (!progress) return
  progress.querySelectorAll('.rx-mt').forEach((n) => n.remove())
  const span = loopEnd - loopStart
  if (!(span > 0)) return
  for (const m of markers) {
    if (m.time < loopStart || m.time > loopEnd) continue
    const tick = progress.ownerDocument.createElement('i')
    tick.className = 'rx-mt'
    tick.style.setProperty('--mc', markerColor(m))
    tick.style.left = `${((m.time - loopStart) / span) * 100}%`
    tick.title = `${m.name} · ${formatMarkerTime(m.time)}`
    progress.appendChild(tick)
  }
}

// The popover. One at a time, closed by Escape, Enter, or a click elsewhere.
let popover = null
let stopOutside = null

export function closeMarkerPopover() {
  if (stopOutside) stopOutside()
  stopOutside = null
  popover?.remove()
  popover = null
}

export function openMarkerPopover(doc, marker, clientX, clientY, { onRename, onColor, onGo, onDelete }) {
  closeMarkerPopover()
  const pop = doc.createElement('div')
  pop.className = 'rx-mpop'
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', 'Marker')
  pop.innerHTML =
    `<input type="text" class="rx-mpop-name" maxlength="40" aria-label="Marker name" value="${escapeHtml(marker.name)}" />` +
    `<div class="rx-mpop-sw">${MARKER_COLORS.map((c, i) => `<button type="button" data-c="${i}" style="--c:${c}" aria-label="Color ${i + 1}" aria-pressed="${marker.color % MARKER_COLORS.length === i}"></button>`).join('')}</div>` +
    `<small>At ${formatMarkerTime(marker.time)}</small>` +
    `<div class="rx-mpop-row"><button type="button" class="rx-b" data-act="go">Go to</button><button type="button" class="rx-b rx-del" data-act="del">${icon('trash-2')}<span>Delete</span></button></div>`
  doc.body.appendChild(pop)
  const win = doc.defaultView
  pop.style.left = `${Math.max(8, Math.min(win.innerWidth - 248, clientX))}px`
  pop.style.top = `${Math.max(8, Math.min(win.innerHeight - 190, clientY + 8))}px`
  popover = pop

  const name = pop.querySelector('.rx-mpop-name')
  name.addEventListener('input', () => onRename(name.value))
  name.addEventListener('keydown', (evt) => {
    evt.stopPropagation()
    if (evt.key === 'Enter' || evt.key === 'Escape') closeMarkerPopover()
  })
  pop.addEventListener('click', (evt) => {
    const sw = evt.target.closest('[data-c]')
    if (sw) {
      pop.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b === sw)))
      onColor(Number(sw.dataset.c))
      return
    }
    const act = evt.target.closest('[data-act]')?.dataset.act
    if (act === 'go') {
      onGo()
      closeMarkerPopover()
    } else if (act === 'del') {
      closeMarkerPopover()
      onDelete()
    }
  })
  const outside = (evt) => {
    if (!pop.contains(evt.target)) closeMarkerPopover()
  }
  // Next tick, so the click that opened it doesn't close it.
  const t = win.setTimeout(() => doc.addEventListener('pointerdown', outside, true), 0)
  stopOutside = () => {
    win.clearTimeout(t)
    doc.removeEventListener('pointerdown', outside, true)
  }
  name.focus()
  name.select()
}
