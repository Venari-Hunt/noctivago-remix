import { LEVEL_HISTORY_LENGTH } from '../domain/levels.js'

export function drawLevelHistory(canvas, history) {
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const width = rect.width
  const height = rect.height
  ctx.clearRect(0, 0, width, height)
  if (history.length < 2) return

  const stepX = width / (LEVEL_HISTORY_LENGTH - 1)
  const startIndex = LEVEL_HISTORY_LENGTH - history.length
  const xAt = (i) => (startIndex + i) * stepX
  const yAt = (i) => height - history[i] * height * 0.95

  ctx.beginPath()
  ctx.moveTo(xAt(0), height)
  for (let i = 0; i < history.length; i++) ctx.lineTo(xAt(i), yAt(i))
  ctx.lineTo(xAt(history.length - 1), height)
  ctx.closePath()
  ctx.fillStyle = 'rgba(122, 162, 247, 0.35)'
  ctx.fill()

  ctx.strokeStyle = '#7aa2f7'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < history.length; i++) {
    if (i === 0) ctx.moveTo(xAt(i), yAt(i))
    else ctx.lineTo(xAt(i), yAt(i))
  }
  ctx.stroke()
}
