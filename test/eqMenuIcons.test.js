import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eqMenuIcon } from '../src/components/eqMenuIcons.js'
import { EQ_TYPE_LABELS } from '../src/components/EqEditor.js'

test('every filter type and both slopes have an icon', () => {
  for (const key of [...Object.keys(EQ_TYPE_LABELS), 'slope-gentle', 'slope-steep']) {
    assert.match(eqMenuIcon(key), /^<svg class="rx-icon rx-eq-curve".*<path d="[^"]+"\/><\/svg>$/, key)
  }
})

test('an unknown name gives no icon', () => {
  assert.equal(eqMenuIcon('nope'), '')
})
