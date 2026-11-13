import test from 'node:test'
import assert from 'node:assert/strict'
import { addMarker, removeMarker, moveMarker, renameMarker, nearestMarker, snapToMarker, normalizeMarkers, markerColor, MARKER_COLORS } from '../src/domain/markers.js'

test('addMarker names, colors and ids in order', () => {
  let { markers } = addMarker([], 3.44)
  assert.equal(markers[0].time, 3.4)
  assert.equal(markers[0].name, 'Marker 1')
  ;({ markers } = addMarker(markers, 9))
  assert.equal(markers[1].name, 'Marker 2')
  assert.equal(markers[1].color, 1)
  assert.equal(markers[1].id, 2)
})

test('addMarker refuses a second marker at the same spot', () => {
  const { markers } = addMarker([], 5)
  const again = addMarker(markers, 5.02)
  assert.equal(again.added, null)
  assert.equal(again.markers.length, 1)
})

test('addMarker clamps into the sound and reuses the lowest free name', () => {
  let { markers } = addMarker([], 1)
  ;({ markers } = addMarker(markers, 2))
  markers = removeMarker(markers, 1)
  const r = addMarker(markers, 99, 10)
  assert.equal(r.added.time, 10)
  assert.equal(r.added.name, 'Marker 1')
  assert.equal(r.added.id, 3)
})

test('rename keeps a fallback and trims', () => {
  const { markers } = addMarker([], 1)
  assert.equal(renameMarker(markers, 1, '  Door  ')[0].name, 'Door')
  assert.equal(renameMarker(markers, 1, '   ')[0].name, 'Marker')
})

test('moveMarker clamps', () => {
  const { markers } = addMarker([], 1)
  assert.equal(moveMarker(markers, 1, -4, 10)[0].time, 0)
  assert.equal(moveMarker(markers, 1, 40, 10)[0].time, 10)
})

test('nearest and snap respect the pixel reach', () => {
  let { markers } = addMarker([], 10)
  ;({ markers } = addMarker(markers, 20))
  assert.equal(nearestMarker(markers, 10.4, 0.5).time, 10)
  assert.equal(nearestMarker(markers, 15, 0.5), null)
  // 0.05 s per pixel, 8 px reach = 0.4 s
  assert.equal(snapToMarker(markers, 10.3, 0.05).time, 10)
  assert.equal(snapToMarker(markers, 10.5, 0.05).marker, null)
  assert.equal(snapToMarker(markers, 10.3, 0.05, 0).marker, null)
  assert.equal(snapToMarker([], 10.3, 0.05).marker, null)
})

test('normalizeMarkers drops junk and fills ids', () => {
  const out = normalizeMarkers([{ time: 4, name: 'a', id: 1, color: 2 }, { time: 'x' }, null, { time: 99 }, { time: 2, id: 1 }], 50)
  assert.equal(out.length, 2)
  assert.equal(new Set(out.map((m) => m.id)).size, 2)
  assert.deepEqual(out.map((m) => m.time), [2, 4])
  assert.deepEqual(normalizeMarkers('nope'), [])
})

test('markerColor wraps', () => {
  assert.equal(markerColor({ color: 5 }), MARKER_COLORS[0])
  assert.equal(markerColor({ color: -1 }), MARKER_COLORS[4])
})
