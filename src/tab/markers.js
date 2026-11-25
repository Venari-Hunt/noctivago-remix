// Timing marker methods of the Remix tab. Each takes the tab.
import { markerKeyAction } from '../domain/markerKeys.js'
import { addMarker, removeMarker, renameMarker, updateMarker } from '../domain/markers.js'
import { saveMarkers } from '../domain/markerStore.js'
import { flashMarkerButton, renderMarkerChips, renderProgressTicks, openMarkerPopover, closeMarkerPopover, formatMarkerTime } from '../components/markerUi.js'

export function setMarkers(tab, list, { save = true } = {}) {
  tab.markers = list
  if (save && tab.currentEntry) saveMarkers(tab.currentEntry.id, list)
  tab.loopEditorController?.setMarkers(list)
  tab.spectralView?.setMarkers(list)
  tab.refreshMarkerUi()
}

export function refreshMarkerUi(tab) {
  if (!tab.markerUi) return
  const points = tab.loopEditorController?.getLoopPoints()
  const selected = tab.loopEditorController?.getSelectedMarker?.() ?? null
  renderMarkerChips(tab.markerUi.list, tab.markers, selected)
  renderProgressTicks(tab.els.stickyProgress, tab.markers, points?.loopStart ?? 0, points?.loopEnd ?? 0)
}

export function addMarkerAtPlayhead(tab) {
  if (!tab.currentEntry || tab.mode !== 'sound') return
  const duration = tab.currentEntry.durationSeconds ?? Infinity
  const t = tab.currentSourceTime()
  const { markers, added } = addMarker(tab.markers, t, duration)
  if (!added) {
    tab.els.saveStatus.textContent = `A marker is already at ${formatMarkerTime(t)}`
    return
  }
  tab.setMarkers(markers)
  tab.loopEditorController?.selectMarker(added.id)
  tab.spectralView?.selectMarker(added.id)
  flashMarkerButton(tab.markerUi?.button)
  tab.els.saveStatus.textContent = `Marker at ${formatMarkerTime(added.time)}`
}

export function goToMarker(tab, id) {
  const marker = tab.markers.find((m) => m.id === id)
  const active = tab.activePreview()
  if (!marker || !active) return
  const t = tab.previewMode === 'saved' ? tab.sourceTimeToClip(marker.time) : marker.time
  active.scrubTo(t)
  tab.loopEditorController?.setPlayhead(marker.time)
  tab.spectralView?.setPlayhead(marker.time)
  tab.updateStickyProgress(t)
}

export function deleteMarker(tab, id) {
  closeMarkerPopover()
  tab.setMarkers(removeMarker(tab.markers, id))
}

export function editMarker(tab, marker, clientX, clientY) {
  tab.loopEditorController?.selectMarker(marker.id)
  tab.spectralView?.selectMarker(marker.id)
  openMarkerPopover(tab.root.ownerDocument, marker, clientX, clientY, {
    onRename: (name) => tab.setMarkers(renameMarker(tab.markers, marker.id, name)),
    onColor: (color) => tab.setMarkers(updateMarker(tab.markers, marker.id, { color })),
    onGo: () => tab.goToMarker(marker.id),
    onDelete: () => tab.deleteMarker(marker.id)
  })
}

// Ctrl+M adds a marker; Delete removes the selected one. Returns true when
// the key was ours.
export function handleMarkerKey(tab, evt) {
  const active = document.activeElement
  const typing = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)
  const selected = tab.loopEditorController?.getSelectedMarker?.()
  const action = markerKeyAction(evt, {
    mode: tab.mode,
    typing,
    hasSelected: selected != null,
    onSpectral: evt.target === tab.els.spectralCanvas
  })
  if (action === 'add') {
    evt.preventDefault()
    tab.addMarkerAtPlayhead()
    return true
  }
  if (action === 'delete') {
    evt.preventDefault()
    tab.deleteMarker(selected)
    return true
  }
  return false
}
