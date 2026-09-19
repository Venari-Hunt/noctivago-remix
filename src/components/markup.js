// HTML snippets for the drift and per-play controls.

export function fluctuationTimingMarkup(idp) {
  return `
              <div class="editor-fluctuation-knobs">
                <label><span>Change every</span>
                  <input id="${idp}-changemin" class="editor-fluctuation-num" type="number" min="0.5" max="300" step="0.5" value="6" />
                  <span class="editor-fluctuation-dash">–</span>
                  <input id="${idp}-changemax" class="editor-fluctuation-num" type="number" min="0.5" max="300" step="0.5" value="14" />
                  <span class="editor-filter-value">s</span>
                </label>
                <label><span>Transition</span>
                  <input id="${idp}-transition" class="editor-fluctuation-num" type="number" min="0" max="120" step="0.5" value="8" />
                  <span class="editor-filter-value">s</span>
                </label>
                <label class="editor-fluctuation-fullrandom">
                  <input id="${idp}-fullrandom" type="checkbox" />
                  <span>Fully random <span class="editor-fluctuation-sub">(ignore the circles — roam the whole range)</span></span>
                </label>
              </div>`
}

// v0.1.218: the Bias toggle every drift bar has, plus (a Sound Group's bars
// only) "Each sound on its own" - locked on for pitch, which a group can
// only do per sound.
export function driftAxisTogglesMarkup(idp, { perSound = false, perSoundLocked = false } = {}) {
  return `
              <div class="editor-fluctuation-knobs">
                <label class="editor-fluctuation-fullrandom">
                  <input id="${idp}-bias" type="checkbox" checked />
                  <span>Bias <span class="editor-fluctuation-sub">(the middle circle wins most of the time; off = anywhere between the outer circles equally)</span></span>
                </label>${
                  perSound
                    ? `
                <label class="editor-fluctuation-fullrandom">
                  <input id="${idp}-persound" type="checkbox"${perSoundLocked ? ' checked disabled' : ''} />
                  <span>Each sound on its own <span class="editor-fluctuation-sub">(${perSoundLocked ? 'always for pitch — ' : ''}every sound in the group drifts separately with these settings, so they don't move together; Random Interval / Scheduled sounds use them as their per-play random range)</span></span>
                </label>`
                    : ''
                }
              </div>`
}

// v0.1.218: a per-play random bar (Random Interval / Scheduled) - same
// 3-circle layout as the drift bars, with Fully random + Bias toggles.
export function shotAxisMarkup(idp, label, sub) {
  return `
            <div class="editor-fluctuation-axis">
              <span class="editor-fluctuation-enable">${label} <span class="editor-fluctuation-sub">${sub}</span></span>
              <canvas id="${idp}-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              <div class="editor-fluctuation-knobs">
                <label class="editor-fluctuation-fullrandom">
                  <input id="${idp}-fully-random" type="checkbox" />
                  <span>Fully random <span class="editor-fluctuation-sub">(ignore the circles — roll the whole range every play)</span></span>
                </label>
                <label class="editor-fluctuation-fullrandom">
                  <input id="${idp}-bias-enabled" type="checkbox" />
                  <span>Bias <span class="editor-fluctuation-sub">(the middle circle wins more often than a plain random pick)</span></span>
                </label>
              </div>
            </div>`
}

// Markup for the Fluctuation block, shared by the Preset and Group filter
// panels (prefix 'preset' | 'group') - one volume bar + the flat-seconds
// timing row + an enable checkbox. Deliberately simpler than Sound mode's own
// two-axis version (no pitch: a bus is a sum of sources).
export function mixFluctuationMarkup(prefix) {
  const scope = prefix === 'group' ? "this group's sounds" : 'the whole mix'
  return `
          <div class="editor-fluctuation">
            <div class="editor-fluctuation-head">
              <span class="editor-fluctuation-label">Fluctuation</span>
              <span class="editor-fluctuation-hint">Slow, random drift on ${scope} — weather rolling through, the ambience swelling and fading on its own. Drag the outer circles for the lowest/highest it reaches, the middle circle for where it sits most of the time. "Change every" is the seconds between new targets (a random value in that range); "Transition" is roughly how long each glide takes. Applies live in the Mixer and is baked into exports.</span>
            </div>
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-mix-${prefix}-fluc-enabled" type="checkbox" />
                Volume drift <span class="editor-fluctuation-sub">(only ever dips below the current level)</span>
              </label>
              <canvas id="editor-mix-${prefix}-fluc-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup(`editor-mix-${prefix}-fluc`)}
              ${driftAxisTogglesMarkup(`editor-mix-${prefix}-fluc`, { perSound: prefix === 'group' })}
            </div>${
              prefix === 'group'
                ? `
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-mix-group-flucpitch-enabled" type="checkbox" />
                Pitch drift <span class="editor-fluctuation-sub">(small shifts read as a gentle wobble)</span>
              </label>
              <canvas id="editor-mix-group-flucpitch-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup('editor-mix-group-flucpitch')}
              ${driftAxisTogglesMarkup('editor-mix-group-flucpitch', { perSound: true, perSoundLocked: true })}
            </div>
            <div class="editor-fluctuation-axis">
              <label class="editor-fluctuation-enable">
                <input id="editor-mix-group-flucpan-enabled" type="checkbox" />
                Pan drift <span class="editor-fluctuation-sub">(the whole group wanders left/right together — while on, it replaces its sounds' own pan drift — or, with "Each sound on its own", every sound wanders separately)</span>
              </label>
              <canvas id="editor-mix-group-flucpan-bar" class="editor-fluctuation-bar" title="Drag the circles. Double-click one to reset it."></canvas>
              ${fluctuationTimingMarkup('editor-mix-group-flucpan')}
              ${driftAxisTogglesMarkup('editor-mix-group-flucpan', { perSound: true })}
            </div>`
                : ''
            }
          </div>`
}
