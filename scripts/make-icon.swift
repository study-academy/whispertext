// Renders the icons. "app" -> 1024 px app icon: a calm grey sound wave on a white squircle with a soft shadow.
// "tray" -> a black template sound wave for the menu bar (18 pt, 1x and 2x).
// Usage: swift scripts/make-icon.swift app build/icon.png | swift scripts/make-icon.swift tray ui/assets/trayTemplate.png 1
import AppKit
let args = CommandLine.arguments
// Bar heights of the wave, low to high to low: a voice, not an equaliser.
let heights: [Double] = [0.22, 0.42, 0.7, 1.0, 0.62, 0.86, 0.48, 0.28]
func bitmap(_ px: Int) -> NSBitmapImageRep {
  NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                   isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
}
func wave(in rect: NSRect, color: NSColor) {
  let count = Double(heights.count), gap = rect.width / (count * 2 - 1)
  color.setFill()
  for (i, h) in heights.enumerated() {
    let height = max(gap, rect.height * h)
    let bar = NSRect(x: rect.minX + Double(i) * 2 * gap, y: rect.midY - height / 2, width: gap, height: height)
    NSBezierPath(roundedRect: bar, xRadius: gap / 2, yRadius: gap / 2).fill()
  }
}
let mode = args[1], out = args[2]
if mode == "app" {
  let rep = bitmap(1024)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
  let path = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
  shadow.shadowBlurRadius = 28
  shadow.shadowOffset = NSSize(width: 0, height: -10)
  NSGraphicsContext.saveGraphicsState()
  shadow.set()
  NSColor.white.setFill()
  path.fill()
  NSGraphicsContext.restoreGraphicsState()
  wave(in: NSRect(x: 262, y: 312, width: 500, height: 400), color: NSColor(calibratedWhite: 0.55, alpha: 1))
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
} else {
  let scale = Int(args[3]) ?? 1, px = 18 * scale
  let rep = bitmap(px)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = Double(scale)
  wave(in: NSRect(x: 1.5 * s, y: 2 * s, width: 15 * s, height: 14 * s), color: .black)
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
}
