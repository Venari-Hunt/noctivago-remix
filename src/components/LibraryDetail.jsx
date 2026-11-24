// The library's drill-in view (approved mock mock-noctivago-remix-detail,
// placement C, owner 2026-11-12), rebuild plan step 3: picking a group or a
// preset replaces the list with its contents. The panel header reads like a
// library row (type tile, name, what it is) and carries the back arrow. Data
// comes from domain/detailPanel.js; every write goes through the handlers.
//
// renderDetail(host, view, h) keeps its old signature. The view and handlers
// live in detailStore (not React state); one root per host renders into its
// own .rx-drill box, which is put back into the host when the list code has
// wiped it. Faders paint imperatively and keep their drag in refs, as before.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { icon } from './icons.js'
import { formatGain, formatPan, gainToFader, faderToGain } from '../domain/detailPanel.js'
import { soundKey, groupKey } from '../domain/itemPreview.js'
import { createStore } from '../state/remixStore.js'
import { escapeHtml, memberRowClass, playState, loopState, soloTitle, memberNameTitle, faderPaint, clamp01, faderKeyValue } from './libraryDetailLogic.js'

const ICON = { group: 'layers', preset: 'bookmark', sound: 'audio-waveform' }
const html = (svg) => ({ __html: svg })

export const detailStore = createStore({ view: null, h: null })

function IconButton({ name, label, onClick, className = '', title }) {
  return <button type="button" className={'rx-i rx-dib' + className} title={title ?? label} aria-label={label} onClick={onClick} dangerouslySetInnerHTML={html(icon(name))} />
}

function Header({ kind, name, meta, back }) {
  return (
    <div className={'rx-det-h' + (back ? ' rx-det-hb' : '')}>
      {back && <IconButton name="arrow-left" label={back.label} onClick={back.onClick} />}
      <span className="rx-thumb" dangerouslySetInnerHTML={html(icon(ICON[kind]))} />
      <div className="rx-det-t">
        <b title={name}>{name}</b>
        <div className="rx-det-kind">{meta}</div>
      </div>
    </div>
  )
}

// A horizontal fader, 0..1. Drag or arrow keys move it (onInput while moving,
// onCommit once at the end); double-click resets volume to 100% and pan to center.
function Fader({ value, pan = false, label, onInput, onCommit, onDragState }) {
  const ref = useRef(null)
  const v = useRef(value)
  const cb = useRef({})
  cb.current = { onInput, onCommit, onDragState }
  const paint = () => {
    const f = ref.current
    if (!f) return
    const p = faderPaint(v.current, pan)
    f.querySelector('.rx-ffl').style.cssText = p.fill
    f.querySelector('.rx-fkn').style.left = `${p.knob}%`
    f.setAttribute('aria-valuenow', String(p.now))
  }
  useLayoutEffect(() => {
    v.current = value
    paint()
  }, [value, pan])
  const set = (next, commit) => {
    v.current = clamp01(next)
    paint()
    cb.current.onInput?.(v.current)
    if (commit) cb.current.onCommit?.(v.current)
  }
  const onPointerDown = (evt) => {
    if (evt.button !== 0) return
    const f = ref.current
    const at = (e) => {
      const r = f.getBoundingClientRect()
      return r.width ? (e.clientX - r.left) / r.width : v.current
    }
    f.setPointerCapture(evt.pointerId)
    cb.current.onDragState?.(true)
    set(at(evt), false)
    const move = (e) => set(at(e), false)
    const up = () => {
      f.removeEventListener('pointermove', move)
      f.removeEventListener('pointerup', up)
      f.removeEventListener('pointercancel', up)
      cb.current.onDragState?.(false)
      cb.current.onCommit?.(v.current)
    }
    f.addEventListener('pointermove', move)
    f.addEventListener('pointerup', up)
    f.addEventListener('pointercancel', up)
  }
  const onKeyDown = (evt) => {
    const next = faderKeyValue(v.current, evt.key, evt.shiftKey)
    if (next == null) return
    evt.preventDefault()
    set(next, true)
  }
  return (
    <div
      ref={ref}
      className={'rx-fader' + (pan ? ' rx-fader-pan' : '')}
      tabIndex={0}
      role="slider"
      aria-label={label}
      aria-valuemin="0"
      aria-valuemax="100"
      onPointerDown={onPointerDown}
      onDoubleClick={() => set(pan ? 0.5 : 1, true)}
      onKeyDown={onKeyDown}
    >
      <i className="rx-ftr" />
      <i className="rx-ffl" />
      <i className="rx-fkn" />
    </div>
  )
}

// Row preview (approved mock, 2026-11-14): Play previews the item with all
// its settings, one item at a time; the same button stops it.
function PlayButton({ itemKey, name, what, h, status }) {
  const s = playState(itemKey, name, what, status)
  return <IconButton name={s.playing ? 'square' : 'play'} label={s.label} title={s.title} className=" rx-mpv" onClick={() => h.preview(itemKey)} />
}

// Loop sits under Play. A one-shot plays once; Loop keeps it repeating with
// its own gap, as in the mix. Greyed for a natural loop (always loops).
function LoopButton({ id, name, h, status }) {
  const s = loopState(id, name, status)
  return (
    <button
      type="button"
      className="rx-i rx-dib rx-mlp"
      disabled={s.disabled}
      aria-pressed={s.pressed == null ? undefined : String(s.pressed)}
      aria-label={s.label}
      title={s.title}
      onClick={() => h.loop(id)}
      dangerouslySetInnerHTML={html(icon('repeat'))}
    />
  )
}

function EmptyNote({ title, text }) {
  return (
    <div className="rx-det-empty">
      {title && <b>{title}</b>}
      <span>{text}</span>
    </div>
  )
}

// One member's two-line row (approved mock, 2026-11-14; Loop moved 2026-11-17):
// Play, name, S, arrow; fader, value, Loop. Play previews that sound with its
// settings (Remix's own engine); S solos it in the Mixer's live mix.
function SoundRow({ m, h, status }) {
  const soloed = status.soloedId === m.id
  const [drag, setDrag] = useState(null)
  const shown = drag && drag.for === m.gain ? drag.gain : m.gain
  const key = soundKey(m.id)
  return (
    <div className={memberRowClass(m, status)} data-key={key}>
      {!m.missing ? <PlayButton itemKey={key} name={m.name} what=" with its settings" h={h} status={status} /> : <span />}
      <span className="rx-mnm" title={memberNameTitle(m, status)}>
        {m.name}
      </span>
      <button type="button" className="rx-mso" aria-pressed={String(soloed)} aria-label={'Solo ' + m.name} title={soloTitle(m, status)} disabled={!m.inMix || Boolean(m.missing)} onClick={() => h.solo(m.id, !soloed)}>
        S
      </button>
      {m.missing ? <span /> : <IconButton name="arrow-right" label={'Edit ' + m.name + ' in Sound mode'} title="Edit in Sound mode" onClick={() => h.editSound(m.id)} />}
      <div className="rx-mf">
        {m.inMix ? (
          <Fader
            value={gainToFader(m.gain)}
            label={`${m.name} volume`}
            onInput={(p) => {
              setDrag({ for: m.gain, gain: faderToGain(p) })
              h.setVolume(m.id, faderToGain(p), false)
            }}
            onCommit={(p) => h.setVolume(m.id, faderToGain(p), true)}
            onDragState={h.dragging}
          />
        ) : (
          <span className="rx-fader-none" />
        )}
        <span className="rx-mval">{m.inMix ? formatGain(shown) : 'off'}</span>
      </div>
      {!m.missing && <LoopButton id={m.id} name={m.name} h={h} status={status} />}
    </div>
  )
}

function MemberRows({ group, h, status }) {
  if (!group.members.length) return <EmptyNote title="No sounds in this group yet" text="Add sounds to it from a card's menu in the Mixer." />
  return (
    <div className="rx-det-rows">
      {group.members.map((m) => (
        <SoundRow key={m.id} m={m} h={h} status={status} />
      ))}
    </div>
  )
}

function GoButton({ kind, text, onClick }) {
  return <button type="button" className="rx-b rx-det-go" onClick={onClick} dangerouslySetInnerHTML={html(`${icon(ICON[kind])}<span>${escapeHtml(text)}</span>`)} />
}

function GroupPanel({ group, parent, h, status }) {
  return (
    <>
      <Header kind="group" name={group.name} meta={parent ? `Group in ${parent}` : group.meta} back={parent ? { label: `Back to ${parent}`, onClick: h.back } : { label: 'Back to all groups', onClick: h.up }} />
      <MemberRows group={group} h={h} status={status} />
      {parent && <GoButton kind="group" text="Edit in Group mode" onClick={() => h.editGroup(group.id)} />}
    </>
  )
}

function Control({ label, children, val }) {
  return (
    <div className="rx-ctl">
      <span>{label}</span>
      {children}
      {val}
    </div>
  )
}

function SoundPanel({ sound, parent, h, status }) {
  const [vol, setVol] = useState(null)
  const [pan, setPan] = useState(null)
  const volShown = vol && vol.for === sound.gain ? vol.gain : sound.gain
  const panShown = pan && pan.for === sound.pan ? pan.pan : sound.pan
  const live = status.live
  const muteTitle = !live ? 'Load this preset in the Mixer first' : !status.canMute ? 'Update Noctívago to mute from here' : undefined
  const soloTitleText = !live ? 'Loads this preset in the Mixer, then plays only this one (preview only, never saved)' : undefined
  return (
    <>
      <Header kind="sound" name={sound.name} meta={`Sound in ${parent}`} back={{ label: `Back to ${parent}`, onClick: h.back }} />
      <Control label="Volume" val={<span className="rx-mval">{formatGain(volShown)}</span>}>
        <Fader
          value={gainToFader(sound.gain)}
          label="Volume"
          onInput={(p) => {
            setVol({ for: sound.gain, gain: faderToGain(p) })
            h.setVolume(sound.id, faderToGain(p), false)
          }}
          onCommit={(p) => h.setVolume(sound.id, faderToGain(p), true)}
          onDragState={h.dragging}
        />
      </Control>
      <Control label="Pan" val={<span className="rx-mval">{formatPan(panShown)}</span>}>
        <Fader
          value={(sound.pan + 1) / 2}
          pan
          label="Pan"
          onInput={(p) => setPan({ for: sound.pan, pan: p * 2 - 1 })}
          onCommit={(p) => h.setPan(sound.id, Math.round((p * 2 - 1) * 100) / 100)}
          onDragState={h.dragging}
        />
      </Control>
      {/* Mute and Solo act on the Mixer's live mix, so this preset must be the one loaded there. */}
      <div className="rx-det-pair">
        <button type="button" className="rx-b rx-ghost" aria-pressed={String(status.muted)} disabled={!live || !status.canMute} title={muteTitle} onClick={() => h.mute(sound.id)} dangerouslySetInnerHTML={html(`${icon('volume-x')}<span>Mute</span>`)} />
        <button type="button" className="rx-b rx-ghost" aria-pressed={String(status.soloed)} title={soloTitleText} onClick={() => h.solo(sound.id, !status.soloed)} dangerouslySetInnerHTML={html('<span class="rx-det-s">S</span><span>Solo</span>')} />
      </div>
      <GoButton kind="sound" text="Edit in Sound mode" onClick={() => h.editSound(sound.id)} />
    </>
  )
}

// A preset's row: Play, then Loop (a sound) or a blank (a group), then the
// row that opens it (mock .prow).
function PreviewRow({ itemKey, transport, children, playing }) {
  return (
    <div className={'rx-drow' + (playing ? ' rx-drow-playing' : '')} data-key={itemKey}>
      {transport}
      {children}
    </div>
  )
}

function SubRow({ kind, name, meta, onClick }) {
  return (
    <button
      type="button"
      className="rx-grow"
      title={name}
      onClick={onClick}
      dangerouslySetInnerHTML={html(`<span class="rx-thumb">${icon(ICON[kind])}</span><span class="rx-gtxt"><span class="rx-gnm">${escapeHtml(name)}</span><small>· ${escapeHtml(meta)}</small></span>${icon('chevron-right')}`)}
    />
  )
}

function Section({ label, count }) {
  return (
    <div className="rx-det-sec">
      <span>{label}</span>
      <span>{String(count)}</span>
    </div>
  )
}

function PresetPanel({ preset, h, status }) {
  const header = <Header kind="preset" name={preset.name} meta={preset.meta} back={{ label: 'Back to all presets', onClick: h.up }} />
  if (preset.empty)
    return (
      <>
        {header}
        <EmptyNote title="This preset is empty" text="Turn sounds on in the Mixer while it is loaded." />
      </>
    )
  return (
    <>
      {header}
      <div className="rx-det-rows">
        {preset.groups.length > 0 && <Section label="Groups" count={preset.groups.length} />}
        {preset.groups.map((g) => {
          const key = groupKey(g.id)
          return (
            <PreviewRow key={key} itemKey={key} playing={status.previewKey === key} transport={[<PlayButton key="p" itemKey={key} name={g.name} what=" as a group" h={h} status={status} />, <span key="b" />]}>
              <SubRow kind="group" name={g.name} meta={`${g.count} sound${g.count === 1 ? '' : 's'}`} onClick={() => h.openSub('group', g.id)} />
            </PreviewRow>
          )
        })}
        <Section label="Sounds outside groups" count={preset.sounds.length} />
        {preset.sounds.length ? (
          preset.sounds.map((s) => {
            const key = soundKey(s.id)
            const transport = s.missing ? [<span key="a" />, <span key="b" />] : [<PlayButton key="p" itemKey={key} name={s.name} what=" with its settings" h={h} status={status} />, <LoopButton key="l" id={s.id} name={s.name} h={h} status={status} />]
            return (
              <PreviewRow key={key} itemKey={key} playing={status.previewKey === key} transport={transport}>
                <SubRow kind="sound" name={s.name} meta={formatGain(s.gain)} onClick={() => h.openSub('sound', s.id)} />
              </PreviewRow>
            )
          })
        ) : (
          <EmptyNote text="Every sound here is in a group." />
        )}
      </div>
    </>
  )
}

function Detail() {
  const { view, h } = useSyncExternalStore(detailStore.subscribe, detailStore.get)
  if (!view) return null
  const { top, sub, status = {} } = view
  if (top.kind === 'group') return <GroupPanel group={top} parent={null} h={h} status={status} />
  if (sub?.kind === 'group') return <GroupPanel group={sub} parent={top.name} h={h} status={status} />
  if (sub?.kind === 'sound') return <SoundPanel sound={sub} parent={top.name} h={h} status={status} />
  return <PresetPanel preset={top} h={h} status={status} />
}

const mounts = new WeakMap()

// view: { top, sub, parentName, status } (see buildStudio). Returns false
// when there is nothing to drill into, so the caller shows the list.
export function renderDetail(host, view, h) {
  if (!view.top) return false
  let m = mounts.get(host)
  if (!m) {
    const box = host.ownerDocument.createElement('div')
    box.className = 'rx-drill'
    m = { box, root: createRoot(box) }
    mounts.set(host, m)
    flushSync(() => m.root.render(<Detail />))
  }
  flushSync(() => detailStore.set({ view, h }))
  if (host.firstChild !== m.box || host.childNodes.length !== 1) host.replaceChildren(m.box)
  return true
}
