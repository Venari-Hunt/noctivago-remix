import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, memberRowClass, playState, loopState, soloTitle, memberNameTitle, faderPaint, faderKeyValue } from '../src/components/libraryDetailLogic.js'
import { soundKey } from '../src/domain/itemPreview.js'

describe('member row', () => {
  const m = { id: 'a', name: 'Wind', inMix: true }
  test('class shows off, solo and playing', () => {
    assert.equal(memberRowClass(m, {}), 'rx-mrow')
    assert.equal(memberRowClass({ ...m, inMix: false }, {}), 'rx-mrow rx-mrow-off')
    assert.equal(memberRowClass(m, { soloedId: 'a', previewKey: soundKey('a') }), 'rx-mrow rx-mrow-solo rx-mrow-playing')
  })
  test('titles', () => {
    assert.equal(soloTitle({ inMix: false }, {}), "Not in this preset's mix")
    assert.match(soloTitle(m, { live: true }), /hear only this one/)
    assert.match(soloTitle(m, { live: false }), /loads this preset/)
    assert.equal(memberNameTitle(m, { kinds: { a: 'random' } }), 'Wind · random one-shot')
    assert.equal(memberNameTitle({ ...m, inMix: false }, {}), "Wind (not in this preset's mix)")
  })
})

describe('play and loop buttons', () => {
  test('play turns into stop for the previewing key', () => {
    assert.deepEqual(playState('k', 'Wind', ' as a group', { previewKey: 'k' }), { playing: true, label: 'Stop Wind', title: 'Stop Wind' })
    assert.deepEqual(playState('k', 'Wind', ' as a group', {}), { playing: false, label: 'Play Wind', title: 'Play Wind as a group' })
  })
  test('loop is locked on for a natural loop, a toggle for a one-shot', () => {
    assert.equal(loopState('a', 'Wind', {}).disabled, true)
    assert.equal(loopState('a', 'Wind', {}).pressed, null)
    const s = loopState('a', 'Wind', { kinds: { a: 'scheduled' }, loops: ['a'] })
    assert.equal(s.disabled, false)
    assert.equal(s.pressed, true)
    assert.match(s.title, /scheduled one-shot/)
  })
})

describe('fader', () => {
  test('volume fills from the left, pan from the center', () => {
    assert.equal(faderPaint(0.25, false).fill, 'left:0;width:25%')
    assert.equal(faderPaint(0.25, true).fill, 'left:25%;width:25%')
    assert.equal(faderPaint(0.75, true).fill, 'left:50%;width:25%')
    assert.equal(faderPaint(0.5, false).now, 50)
  })
  test('keys step, clamp and jump', () => {
    assert.equal(faderKeyValue(0.5, 'ArrowRight', false), 0.52)
    assert.equal(faderKeyValue(0.5, 'ArrowLeft', true), 0.4)
    assert.equal(faderKeyValue(0.99, 'ArrowUp', true), 1)
    assert.equal(faderKeyValue(0.5, 'Home', false), 0)
    assert.equal(faderKeyValue(0.5, 'End', false), 1)
    assert.equal(faderKeyValue(0.5, 'a', false), null)
  })
})

test('escapeHtml', () => assert.equal(escapeHtml('<a "b" & c>'), '&lt;a &quot;b&quot; &amp; c&gt;'))
