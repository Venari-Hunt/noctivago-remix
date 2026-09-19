// Loads a file from the Noctívago app's own source on GitHub, so tests can
// check that this plugin's copies of core rules still match the app. A plugin
// can't import the app's files at runtime, so it keeps copies; these tests
// catch the copies drifting apart. Returns null when GitHub can't be reached,
// and the calling test skips.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE = 'https://raw.githubusercontent.com/Venari-Hunt/Noctivago/master/'

export async function loadCore(relPath) {
  let text
  try {
    const res = await fetch(BASE + relPath)
    if (!res.ok) return null
    text = await res.text()
  } catch {
    return null
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noctivago-core-')), path.basename(relPath))
  fs.writeFileSync(file, text)
  return { text, module: await import(pathToFileURL(file).href) }
}
