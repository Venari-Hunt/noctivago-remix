import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Runs the worklet the way the browser will: the DSP text with its `export`s
// stripped, then the worklet file, inside a sandbox that stands in for the
// AudioWorklet globals. Proves the combined text parses and that boxes land at
// the source time the page's anchor says.
function loadProcessor(sampleRate) {
  const dsp = fs.readFileSync(new URL('../src/audio/spectralRepairDsp.js', import.meta.url), 'utf8').replace(/^export /gm, '')
  const worklet = fs.readFileSync(new URL('../src/audio/spectralRepairWorklet.js', import.meta.url), 'utf8')
  let Processor = null
  const sandbox = {
    sampleRate,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {}
      }
    },
    registerProcessor: (name, cls) => {
      Processor = cls
    },
    Float32Array,
    Float64Array,
    Math
  }
  vm.createContext(sandbox)
  vm.runInContext(dsp + '\n' + worklet, sandbox)
  return { Processor, sandbox }
}

const SR = 44100
const rms = (x, a, b) => Math.sqrt(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a))

test('worklet text parses and a box is applied at the anchored source time', () => {
  const { Processor, sandbox } = loadProcessor(SR)
  const p = new Processor()
  p.port.onmessage({ data: { regions: [{ startSec: 10, endSec: 11, lowHz: 2500, highHz: 3500, reductionDb: 60 }] } })
  // The audio entering at context time 0 is at source time 9.5 s, normal speed:
  // the box (10-11 s) is reached 0.5 s in and left 1.5 s in.
  p.port.onmessage({ data: { anchor: { ctxTime: 0, t0: 9.5, rate: 1 } } })
  const total = 128 * Math.ceil((SR * 3) / 128)
  const input = new Float32Array(total)
  for (let i = 0; i < total; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 3000 * i) / SR)
  const out = new Float32Array(total)
  for (let i = 0; i < total; i += 128) {
    sandbox.currentFrame = i
    const o = [new Float32Array(128)]
    p.process([[input.subarray(i, i + 128)]], [o])
    out.set(o[0], i)
  }
  // Output runs one frame (4096 samples) late. Inside the box, after the late-fade:
  const at = (t) => Math.round(SR * t) + 4096
  assert.ok(rms(out, at(0.7), at(1.3)) < 0.01, 'inside the box the 3 kHz tone is gone')
  assert.ok(rms(out, at(0.1), at(0.3)) > 0.3, 'before the box it is intact')
  assert.ok(rms(out, at(1.7), at(1.9)) > 0.3, 'after the box it is intact')
})
