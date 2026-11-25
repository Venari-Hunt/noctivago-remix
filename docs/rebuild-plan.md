# Remix rebuild plan: plain JS to React components

Owner request, 2026-11-14. Goal: the Remix tab built from React components like the Mixer
(`src/renderer/tabs/mixer/components/*.jsx` in the app), with no change to how it looks or behaves.

## Where it stands (ui-redesign, 2026-11-17)

- `src/components/RemixTab.js`, 6,222 lines: one class. `mount()` writes about 1,250 lines of
  markup with `innerHTML`, then `arrangeLayout()` (`layout.js`, 1,244 lines) moves that DOM into
  the 2.0 grid (canvas column, accordions, sticky bar). The rest is wiring, state, save, undo.
- Canvas controllers, plain JS, already separate: `LoopEditor.js`, `SeamView.js`, `EqEditor.js`,
  `SpectralRepairView.js`, `FluctuationBar.js`, `WaveformScrollbar.js`. They stay plain JS; React
  only hosts them through a ref.
- One React island already: `FilterControls.jsx` (Tone, Clean, Space knobs). Its values sit in a tiny
  external store read with `useSyncExternalStore`, because the tab reads values right after writing
  them, before React renders. Every new component uses the same pattern.
- Copied code to fold: EQ compare / revert / banner exists three times (Sound, Group, Preset);
  drift read / write twice (Sound, mix); two knob drawings (`attachKnob` in `Knob.js` and the
  `Knob` inside `FilterControls.jsx`).

## Rules for every step

1. One panel per PR into `ui-redesign`. No look or behavior change.
2. Keep every element id and class the e2e tests and `styles.css` use.
3. Done = `npm test` here, the app's Remix e2e files, `knob-select.e2e.mjs` and `ui-audit.e2e.mjs`
   pass, plus before/after screenshots at 1280 and 860 px that match.
4. State goes in a store (`src/state/remixStore.js`), never only in React state, so `RemixTab`
   keeps reading values synchronously until the last step.

## Steps

| # | Piece | Guarded by |
|---|---|---|
| 0 | Fill test gaps before moving anything (app repo, one PR): typed loop Start/End, Schedule, sound picker, Group mode select/create/save, undo/redo after an edit. No e2e covers these today. | the new e2e files |
| 1 | `Knob.jsx`: one knob for the whole tab. `attachKnob` becomes a thin wrapper that mounts it, `FilterControls` uses it. | `knob.test.js`, `knob-select.e2e.mjs` |
| 2 | `remixStore.js`: the generic store from `FilterControls`, with unit tests. | new unit test |
| 3 | Library detail and preview buttons: `libraryDetail.js` to `LibraryDetail.jsx` (group, preset, member rows). Waits for PR #26 (row Play follows the mode) to merge. | `remix-item-preview`, `remix-member-row` |
| 4 | `Accordion.jsx` + header values (`refreshAccordionSummaries`). | `remix-drift` |
| 5 | Sound-mode panels, one PR each: Playback (play mode, fade, crossfade, scatter, schedule), Speed and pitch, Drift (wraps `FluctuationBar`), Spectral controls. | `remix-drift`, `pitch`, step 0 tests |
| 6 | Canvas views as host components (Trim, Loop seam, EQ, Spectrum) that wrap the existing controllers. | `remix-waveform`, `remix-eq-live`, `eq-cut-q`, `repair`, `repair-freehand`, `remix-markers` |
| 7 | Sticky bar: player, picker, progress, markers. | `remix-space`, `remix-markers`, `remix-responsive` |
| 8 | Group panel, then Preset panel, sharing one `useEqTarget` hook (ends the three EQ copies). | `remix-member-row`, `remix-item-preview`, `remix-drift`, step 0 tests |
| 9 | `RemixApp.jsx` root replaces `mount()`'s markup and `arrangeLayout()`. `RemixTab.js` keeps lifecycle, audio, load, save and undo; target under 1,500 lines. | the whole Remix e2e set |

Step 9 progress (layout.js, one PR per region, each into ui-redesign):

- #56: RemixApp.jsx renders the tab shell (mode switch, picker row, panels, leave-confirm modal).
- Studio panes: library, preview module and head are RemixApp markup (, , );  only wires them.
- Left: canvas column, settings column and accordions, Group and Preset scope layouts, .

About 13 PRs. Steps 1 and 3 come first because other open tasks touch knobs and preview buttons.

## Risks

- Reading a value right after writing it: solved by the store, not React state (see `FilterControls`).
- The app's double-click-resets-a-slider listener skips React-controlled ranges: components handle
  `onDoubleClick` themselves (app `docs/plugins.md`).
- Canvas controllers keep their DOM; a React re-render must never replace their host element
  (host components render once and pass a ref).
