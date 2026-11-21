// Small macOS helper for the Electron app: reports modifier changes (fn, Control, Option, others) and
// whether a non-modifier key went down, and pastes on request. Listen-only: it never reads characters,
// never changes or suppresses an event. Protocol: JSON lines on stdout, plain commands on stdin.
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

func permissions() -> [String: Any] {
    ["type": "permissions", "input": CGPreflightListenEventAccess(), "accessibility": AXIsProcessTrusted(), "listening": tap != nil]
}

var tap: CFMachPort?
// Accessibility alone allows a listen-only tap; Input Monitoring is only a fallback for older grants.
func mayListen() -> Bool { AXIsProcessTrusted() || CGPreflightListenEventAccess() }
var targetPID: pid_t?
var targetField: AXUIElement?
struct CapturedTarget {
    let pid: pid_t
    let field: AXUIElement?
    let range: CFRange?
    let created: TimeInterval
}
var capturedTargets: [Int: CapturedTarget] = [:]
var latestTargetID = 0
struct InsertedRegion {
    let pid: pid_t
    let field: AXUIElement
    let prefix: String
    let suffix: String
    let created: TimeInterval
}
var insertedRegions: [Int: InsertedRegion] = [:]
func selectedRange(_ field: AXUIElement) -> CFRange? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
    return range
}
var pendingClipboardRestore: (() -> Void)?
var clipboardRestoreID = 0
func restoreClipboard() { pendingClipboardRestore?(); pendingClipboardRestore = nil }

// The fn key belongs to Studymut while it is the hold key: its presses stop here, so macOS never sees "fn twice"
// (its own dictation) or a single fn (the emoji picker). Other keys held with fn are not touched: arrows and
// function keys carry the fn flag themselves. "fn-keep" hands the key back when another hold key is chosen.
var swallowFn = true
// By choice (settings, "Emoji-Taste"): the key left of 1 on an ISO keyboard (^ and ° on a German one) opens the emoji
// picker while Studymut runs. With Command it still writes ^, with Command and Shift °; with Shift alone it does nothing.
var emojiKey = false
// While a hands-free dictation runs, Return is its ✓: it ends the dictation instead of reaching the app in front.
var ownReturn = false
let ISO_SECTION_KEY: Int64 = 10

func postPlain(_ text: String) {
    let source = CGEventSource(stateID: .privateState)
    let units = Array(text.utf16)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        event.flags = []
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        event.post(tap: .cgSessionEventTap)
    }
}
func postEmojiPicker() {
    let source = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: down) else { continue }
        event.flags = [.maskControl, .maskCommand]
        event.post(tap: .cgSessionEventTap)
    }
}

func startTap() -> Bool {
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue) | CGEventMask(1 << CGEventType.keyDown.rawValue) | CGEventMask(1 << CGEventType.keyUp.rawValue)
    // An active tap (passing every event through unchanged) is covered by Accessibility. A listen-only tap
    // needs Input Monitoring on current macOS: it is created, but receives no keys without it.
    // At the HID level, before the system looks at the key: a session tap comes after macOS has counted the presses.
    guard let port = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                                       eventsOfInterest: mask, callback: { _, type, event, _ in
        switch type {
        case .flagsChanged:
            let f = event.flags
            emit(["type": "flags", "hold": f.contains(.maskSecondaryFn), "control": f.contains(.maskControl),
                  "option": f.contains(.maskAlternate), "other": !f.intersection([.maskCommand, .maskShift]).isEmpty,
                  // Left/right device bits, so right Option or right Command can stand in for fn.
                  "device": Int(f.rawValue & 0xFFFF)])
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            if swallowFn && (code == 63 || code == 179) { return nil }
        case .keyUp where ownReturn && [36, 76].contains(event.getIntegerValueField(.keyboardEventKeycode)):
            return nil
        case .keyDown where ownReturn && [36, 76].contains(event.getIntegerValueField(.keyboardEventKeycode)):
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { emit(["type": "return"]) }
            return nil
        case .keyUp:
            if emojiKey && event.getIntegerValueField(.keyboardEventKeycode) == ISO_SECTION_KEY { return nil }
        case .keyDown where emojiKey && event.getIntegerValueField(.keyboardEventKeycode) == ISO_SECTION_KEY:
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
                let f = event.flags
                if f.contains(.maskCommand) { postPlain(f.contains(.maskShift) ? "°" : "^") }
                else if !f.contains(.maskShift) { postEmojiPicker(); emit(["type": "emoji-key"]) }
            }
            return nil
        case .keyDown where [63, 179].contains(event.getIntegerValueField(.keyboardEventKeycode)):
            // The fn/Globe key itself also arrives as a key on newer Macs. It is not typing: reporting it would end
            // a double tap of fn before it is complete (whispertext, 20.11.2026), and when fn is ours macOS gets none.
            if swallowFn { return nil }
        case .keyDown:
            // Arrow and function keys carry the fn flag themselves; only the key code is read.
            emit(["type": "key", "escape": event.getIntegerValueField(.keyboardEventKeycode) == 53, "code": Int(event.getIntegerValueField(.keyboardEventKeycode))])
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        default: break
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: nil) else { return false }
    tap = port
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0), .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    return true
}

// Remember only focused AX element identity and process, never its contents.
func focusedField(_ pid: pid_t) -> AXUIElement? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &result) == .success,
          let result, CFGetTypeID(result) == AXUIElementGetTypeID() else { return nil }
    return (result as! AXUIElement)
}
// Where the selected text stands on the screen (global points), so a suggestion can appear right at it.
func selectionBounds(_ field: AXUIElement) -> [Int]? {
    var rangeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, &rangeValue) == .success, let rangeValue else { return nil }
    var bounds: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(field, kAXBoundsForRangeParameterizedAttribute as CFString, rangeValue, &bounds) == .success,
          let bounds, CFGetTypeID(bounds) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(bounds as! AXValue, .cgRect, &rect), rect.width > 0, rect.height > 0 else { return nil }
    return [Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height)]
}
func captureTarget(_ id: Int = 0) {
    targetPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
    // Chromium and Electron apps build their accessibility tree only on request; this asks for it
    // (as Wispr Flow and HeyClicky do), so their text fields can be recognised.
    if let pid = targetPID { AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) }
    targetField = targetPID.flatMap { focusedField($0) }
    // Which app the words go to (for its writing style) and any selected text there (for the command mode:
    // "make this shorter"). Nothing is read in secure fields; the selection is not kept beyond this turn.
    let front = NSWorkspace.shared.frontmostApplication
    var selection = ""
    if let field = targetField, !IsSecureEventInputEnabled() {
        var subrole: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(field, kAXSubroleAttribute as CFString, &subrole)
        var selected: CFTypeRef?
        if (subrole as? String) != kAXSecureTextFieldSubrole,
           AXUIElementCopyAttributeValue(field, kAXSelectedTextAttribute as CFString, &selected) == .success,
           let text = selected as? String, text.utf16.count <= 8000 { selection = text }
    }
    latestTargetID = id
    let now = ProcessInfo.processInfo.systemUptime
    capturedTargets = capturedTargets.filter { now - $0.value.created < 180 }
    if capturedTargets.count >= 32, let oldest = capturedTargets.min(by: { $0.value.created < $1.value.created })?.key { capturedTargets.removeValue(forKey: oldest) }
    if let pid = targetPID { capturedTargets[id] = CapturedTarget(pid: pid, field: targetField, range: targetField.flatMap(selectedRange), created: now) }
    var domain = "", beforeText = "", afterText = ""
    if !IsSecureEventInputEnabled(), let field = targetField, !isSecure(field) {
        // Read the focused field and window only; never walk browser toolbars or collect a full tree.
        AXUIElementSetMessagingTimeout(field, 0.08)
        if let range = selectedRange(field), let value = fieldValue(field), value.utf16.count <= 200_000,
           range.location >= 0, range.length >= 0, range.location + range.length <= value.utf16.count {
            let string = value as NSString
            beforeText = String(string.substring(to: range.location).suffix(200))
            afterText = String(string.substring(from: range.location + range.length).prefix(200))
        }
        func documentDomain(_ element: AXUIElement) -> String {
            var document: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, kAXDocumentAttribute as CFString, &document) == .success,
                  let raw = document as? String, raw.utf8.count <= 8192, let url = URL(string: raw),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return "" }
            return url.host?.lowercased() ?? ""
        }
        domain = documentDomain(field)
        if domain.isEmpty, let pid = targetPID {
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.08)
            var window: CFTypeRef?
            if AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &window) == .success,
               let window, CFGetTypeID(window) == AXUIElementGetTypeID() { domain = documentDomain(window as! AXUIElement) }
        }
    }
    emit(["type": "target", "targetId": id, "app": front?.bundleIdentifier ?? "", "name": front?.localizedName ?? "", "selection": selection,
          "domain": domain, "beforeText": beforeText, "afterText": afterText,
          "bounds": (selection.isEmpty ? nil : targetField.flatMap(selectionBounds)) as Any? ?? NSNull()])
    if CommandLine.arguments.contains("--diagnose") {
        var role: CFTypeRef?
        if let field = targetField { _ = AXUIElementCopyAttributeValue(field, kAXRoleAttribute as CFString, &role) }
        emit(["type":"target-diagnostic","role":role as? String ?? "unavailable", "app": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unavailable"])
    }
}
var pasteRequestID = 0
// What the field a dictation went into holds now, for learning the person's own fixes. The place is kept for ten
// minutes and read as often as asked (15.11.2026: it was forgotten after the first look, and a fix needs two looks,
// so nothing was ever learned). The whole field comes back, because the person dictates on and fixes earlier
// words; the caller finds the dictated words in it. Only while that very field has the focus, never a secure one.
func readInserted(_ requestID: Int = 0, pasteID: Int = 0) {
    func reply(_ value: String?) { emit(["type": "field", "id": requestID, "pasteId": pasteID, "value": value as Any? ?? NSNull()]) }
    guard let region = insertedRegions[pasteID],
          ProcessInfo.processInfo.systemUptime - region.created < 600,
          !IsSecureEventInputEnabled(), NSWorkspace.shared.frontmostApplication?.processIdentifier == region.pid,
          let current = focusedField(region.pid), CFEqual(current, region.field),
          !isSecure(region.field), let value = fieldValue(region.field), value.utf16.count <= 50_000 else { reply(nil); return }
    reply(value)
}
// A dictation was inserted at once and tidied by the AI a moment later: the tidied text takes its place, but only
// while everything is exactly as it was left. The same app in front, the same field, the inserted text untouched and
// the caret still right behind it. Anything else (the person typed on, clicked elsewhere, sent the message) and
// nothing happens. The place is remembered again for the new text, so later learning still finds it.
func replaceInserted(_ requestID: Int, pasteID: Int, expected: String, replacement: String) {
    func reply(_ ok: Bool, _ reason: String = "", _ method: String = "") { emit(["type": "acted", "id": requestID, "ok": ok, "reason": reason, "method": method]) }
    guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { reply(false, "not-allowed"); return }
    guard let region = insertedRegions[pasteID], ProcessInfo.processInfo.systemUptime - region.created < 90 else { reply(false, "no-region"); return }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == region.pid,
          let current = focusedField(region.pid), CFEqual(current, region.field), !isSecure(region.field) else { reply(false, "focus-changed"); return }
    guard let value = fieldValue(region.field), value.utf16.count <= 200_000, value.hasPrefix(region.prefix), value.hasSuffix(region.suffix) else { reply(false, "text-changed"); return }
    let whole = value as NSString, start = region.prefix.utf16.count, length = whole.length - start - region.suffix.utf16.count
    guard length >= 0, whole.substring(with: NSRange(location: start, length: length)) == expected else { reply(false, "text-changed"); return }
    guard let caret = selectedRange(region.field), caret.length == 0, caret.location == start + length else { reply(false, "caret-moved"); return }
    // Select exactly what was inserted, and make sure the field really took that selection.
    var wanted = CFRange(location: start, length: length)
    guard let boxed = AXValueCreate(.cfRange, &wanted),
          AXUIElementSetAttributeValue(region.field, kAXSelectedTextRangeAttribute as CFString, boxed) == .success,
          let selected = selectedRange(region.field), selected.location == start, selected.length == length else {
        // Half a selection is worse than none: the caret goes back behind the text.
        var back = CFRange(location: start + length, length: 0)
        if let boxedBack = AXValueCreate(.cfRange, &back) { AXUIElementSetAttributeValue(region.field, kAXSelectedTextRangeAttribute as CFString, boxedBack) }
        reply(false, "no-selection"); return
    }
    let goal = region.prefix + replacement + region.suffix
    func putCaret(_ location: Int) {
        var range = CFRange(location: location, length: 0)
        if let boxed = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(region.field, kAXSelectedTextRangeAttribute as CFString, boxed) }
    }
    // The text must never be left selected (14.11.2026: a field that ignored the new text kept the whole
    // dictation marked blue, and the next key would have replaced it). Untouched text gets its caret back.
    func giveUp(_ reason: String, _ method: String) {
        if fieldValue(region.field) == value { putCaret(start + length) }
        reply(false, reason, method)
    }
    func stillSelected() -> Bool {
        guard let now = selectedRange(region.field), now.location == start, now.length == length else { return false }
        var text: CFTypeRef?
        // Where the field tells what is marked, it must be exactly the dictation; where it does not, the range counts.
        if AXUIElementCopyAttributeValue(region.field, kAXSelectedTextAttribute as CFString, &text) == .success, let marked = text as? String, !marked.isEmpty { return marked == expected }
        return true
    }
    // Typed over the selection, for fields that take no text through accessibility (Chromium and Electron apps,
    // many web pages). A line break is Shift + Return there: a new line, never "send".
    func typeOver() {
        guard replacement.utf16.count <= 1500, stillSelected() else { giveUp("not-settable", "typed"); return }
        typeText(replacement, softBreaks: true)
        settle(5, "typed")
    }
    // The field may take the text a moment later: looked at a few times.
    func settle(_ tries: Int, _ method: String) {
        let now = fieldValue(region.field)
        if now == goal {
            if method == "direct" { putCaret(start + replacement.utf16.count) }
            else if let range = selectedRange(region.field), range.length > 0 { putCaret(range.location + range.length) }
            reply(true, "", method); return
        }
        // Said to be settable, but nothing changed (Chromium does that): typed instead.
        if method == "direct", tries <= 2, now == value { typeOver(); return }
        if tries <= 0 { giveUp("unverified", method); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { settle(tries - 1, method) }
    }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(region.field, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue {
        _ = AXUIElementSetAttributeValue(region.field, kAXSelectedTextAttribute as CFString, replacement as CFString)
        settle(4, "direct")
    } else { typeOver() }
}
func pasteReply(_ payload: [String: Any], id: Int? = nil) {
    var value = payload
    value["type"] = "paste"
    value["id"] = id ?? pasteRequestID
    emit(value)
}
func rememberInsertion(_ id: Int, pid: pid_t, field: AXUIElement?, before: String?, range: CFRange?, expectedText: String? = nil) {
    guard let field, let before, let range, range.location >= 0, range.length >= 0,
          range.location + range.length <= before.utf16.count, before.utf16.count <= 200_000 else { return }
    let string = before as NSString
    if let expectedText {
        let expected = string.replacingCharacters(in: NSRange(location: range.location, length: range.length), with: expectedText)
        guard fieldValue(field) == expected else { return }
    }
    let now = ProcessInfo.processInfo.systemUptime
    insertedRegions = insertedRegions.filter { now - $0.value.created < 600 }
    if insertedRegions.count >= 32, let oldest = insertedRegions.min(by: { $0.value.created < $1.value.created })?.key { insertedRegions.removeValue(forKey: oldest) }
    insertedRegions[id] = InsertedRegion(pid: pid, field: field, prefix: string.substring(to: range.location),
        suffix: string.substring(from: range.location + range.length), created: now)
}
// Whether the focused element takes text: true for a text field, false only where text clearly
// never goes (a list, a button, the desktop), nil when it cannot be told. Chromium and Electron apps
// (Chrome, Slack, Notion, VS Code) build accessibility lazily and often report a group or nothing
// while their text box has the focus, so an unknown role is trusted, as Wispr Flow and Coucou do.
func takesText(_ element: AXUIElement) -> Bool? {
    var roleValue: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue)
    let role = roleValue as? String
    if let role, ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXWebArea"].contains(role) { return true }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue { return true }
    var range: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &range) == .success { return true }
    let never: Set<String> = ["AXList", "AXOutline", "AXTable", "AXRow", "AXCell", "AXBrowser", "AXImage", "AXButton", "AXCheckBox",
                              "AXRadioButton", "AXSlider", "AXPopUpButton", "AXMenu", "AXMenuItem", "AXMenuBar", "AXMenuBarItem", "AXDockItem"]
    if let role, never.contains(role) { return false }
    return nil
}
func fieldValue(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else { return nil }
    return value as? String
}
// AXSelectedText can report writable while Chromium/Electron ignores the write. Route those apps
// to clipboard before any mutation; a failed verification after an attempted native write stays unknown.
func usesNativeTextInsertion(bundleID: String?) -> Bool {
    switch bundleID {
    case "com.apple.TextEdit", "com.apple.mail", "com.apple.Notes": return true
    default: return false
    }
}
enum DirectInsertion { case notAttempted, confirmed, unknown }
func insertDirectly(_ text: String, into element: AXUIElement) -> DirectInsertion {
    var roleValue: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue)
    guard let role = roleValue as? String, [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role) else { return .notAttempted }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue,
          let before = fieldValue(element), before.utf16.count < 200_000 else { return .notAttempted }
    let range = selectedRange(element)
    _ = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
    guard let after = fieldValue(element) else { return .unknown }
    if let range, range.location >= 0, range.length >= 0, range.location + range.length <= before.utf16.count {
        let expected = (before as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
        if after == expected { return .confirmed }
    }
    // A successful write may be applied asynchronously. Never blindly paste again in that case.
    return .unknown
}
func paste(_ text: String, deadline: Double, targetID: Int? = nil) {
    let requestID = pasteRequestID
    func reply(_ payload: [String: Any]) { pasteReply(payload, id: requestID) }
    if activeProvider != nil { reply(["ok":false,"reason":"paste-busy"]); return }
    guard Date().timeIntervalSince1970 * 1000 < deadline else { reply(["ok":false,"reason":"expired"]); return }
    guard AXIsProcessTrusted() else { reply(["ok":false,"reason":"accessibility"]); return }
    guard !IsSecureEventInputEnabled() else { reply(["ok":false,"reason":"secure-field"]); return }
    let captureID = targetID ?? latestTargetID
    guard let target = capturedTargets.removeValue(forKey: captureID), ProcessInfo.processInfo.systemUptime - target.created < 180 else { reply(["ok":false,"reason":"no-target"]); return }
    let pid = target.pid
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { reply(["ok":false,"reason":"focus-changed"]); return }
    let current = focusedField(pid)
    if let field = target.field {
        guard let current, CFEqual(field, current) else { reply(["ok":false,"reason":"focus-changed"]); return }
    }
    if let expected = target.range, let current {
        guard let actual = selectedRange(current), expected.location == actual.location, expected.length == actual.length else { reply(["ok":false,"reason":"caret-changed"]); return }
    }
    if let current {
        if isSecure(current) { reply(["ok":false,"reason":"secure-field"]); return }
        if takesText(current) == false { reply(["ok":false,"reason":"not-a-text-field"]); return }
    } else if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.finder" {
        reply(["ok":false,"reason":"not-a-text-field"]); return
    }
    let before = current.flatMap(fieldValue)
    let range = current.flatMap(selectedRange)
    if let current, usesNativeTextInsertion(bundleID: NSWorkspace.shared.frontmostApplication?.bundleIdentifier) {
        switch insertDirectly(text, into: current) {
        case .confirmed:
            rememberInsertion(requestID, pid: pid, field: current, before: before, range: range)
            reply(["ok":true,"method":"direct","verification":"field-confirmed"]); return
        case .unknown: reply(["ok":NSNull(),"reason":"direct-unverified","method":"direct","verification":"unknown"]); return
        case .notAttempted: break
        }
    }
    let board = NSPasteboard.general
    // Preserve all types and items, including images, rich text and file URLs.
    let snapshotChange = board.changeCount
    var complete = true
    let snapshot = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } else { complete = false } }
        return copy
    }
    guard complete else { reply([ "ok": false,"reason":"clipboard-unavailable"]); return }
    guard board.changeCount == snapshotChange,
          Date().timeIntervalSince1970 * 1000 < deadline,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        reply(["ok":false,"reason":"changed-during-snapshot"]); return
    }
    let provider = PasteProvider(text)
    let item = NSPasteboardItem()
    item.setDataProvider(provider, forTypes: [.string])
    for marker in ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "org.nspasteboard.AutoGeneratedType"] {
        item.setData(Data(), forType: NSPasteboard.PasteboardType(marker))
    }
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { reply(["ok":false,"reason":"keystroke"]); return }
    board.clearContents()
    guard board.writeObjects([item]) else {
        board.clearContents(); if !snapshot.isEmpty { board.writeObjects(snapshot) }
        reply(["ok":false,"reason":"clipboard-write"]); return
    }
    let change = board.changeCount
    activeProvider = provider
    clipboardRestoreID += 1
    let restoreID = clipboardRestoreID
    var answered = false
    func answer(_ value: [String: Any]) { if !answered { answered = true; reply(value) } }
    pendingClipboardRestore = {
        if board.changeCount == change { board.clearContents(); if !snapshot.isEmpty { board.writeObjects(snapshot) } }
        provider.onRequest = nil
        if activeProvider === provider { activeProvider = nil }
        answer(["ok":NSNull(),"reason":"cancelled","verification":"unknown"])
    }
    provider.onRequest = {
        guard provider.injectedAt != nil else { return }
        // Observation is off the paste hot path and only learns if the exact insertion was seen first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            guard restoreID == clipboardRestoreID, activeProvider === provider else { return }
            rememberInsertion(requestID, pid: pid, field: current, before: before, range: range, expectedText: text)
        }
        answer(["ok":true,"method":"clipboard","verification":"clipboard-read"])
    }
    down.flags = .maskCommand; up.flags = .maskCommand
    provider.injectedAt = ProcessInfo.processInfo.systemUptime
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    let started = ProcessInfo.processInfo.systemUptime
    func settle() {
        guard restoreID == clipboardRestoreID, activeProvider === provider else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if board.changeCount != change {
            answer(["ok":NSNull(),"reason":"clipboard-changed","verification":"unknown"])
            restoreClipboard(); return
        }
        if let last = provider.lastReadAt, now - last >= 0.2 { restoreClipboard(); return }
        if now - started >= 2.0 {
            answer(["ok":NSNull(),"reason":"not-requested","verification":"unknown"])
            restoreClipboard(); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) { settle() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) { settle() }
}

final class PasteProvider: NSObject, NSPasteboardItemDataProvider {
    let text: String
    var injectedAt: TimeInterval?
    var lastReadAt: TimeInterval?
    var onRequest: (() -> Void)?
    init(_ text: String) { self.text = text }
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard type == .string else { return }
        item.setString(text, forType: type)
        let now = ProcessInfo.processInfo.systemUptime
        guard let injectedAt, now >= injectedAt else { return }
        lastReadAt = now
        let done = onRequest
        DispatchQueue.main.async { done?() }
    }
}
var activeProvider: PasteProvider?

// Acting for the person (only after they confirmed in the notch, see main/actions.js): reading what can be
// clicked in the frontmost window, clicking, typing and pressing keys. Never in secure input.
func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}
func axFrame(_ element: AXUIElement) -> CGRect? {
    var position: CFTypeRef?, size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return CGRect(origin: point, size: extent)
}
func axURL(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, "AXURL" as CFString, &value) == .success, let value else { return nil }
    if let url = value as? URL { return url.absoluteString }
    return value as? String
}
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var children: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success, let list = children as? [AXUIElement] else { return [] }
    return list
}
// Role, name, place and children of one element in a single round trip to its app instead of six: reading a
// full window (a week in Calendar, a long page) took over a second before, most of it waiting between calls.
let nodeAttributes = [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute] as CFArray
struct AXNode { let role: String; let title: String?; let description: String?; let frame: CGRect?; let children: [AXUIElement] }
func axNode(_ element: AXUIElement) -> AXNode? {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, nodeAttributes, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
          let list = values as? [AnyObject], list.count == 6 else { return nil }
    // A missing attribute comes back as an error value, never as nil: each one is checked for its kind.
    func typed(_ value: AnyObject, _ kind: AXValueType) -> AXValue? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let boxed = value as! AXValue
        return AXValueGetType(boxed) == kind ? boxed : nil
    }
    var frame: CGRect? = nil
    if let position = typed(list[3], .cgPoint), let extent = typed(list[4], .cgSize) {
        var point = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(position, .cgPoint, &point)
        AXValueGetValue(extent, .cgSize, &size)
        frame = CGRect(origin: point, size: size)
    }
    return AXNode(role: list[0] as? String ?? "", title: list[1] as? String, description: list[2] as? String, frame: frame, children: list[5] as? [AXUIElement] ?? [])
}
// The page inside a browser window (or any web view): found first, so a page's own controls are listed before
// the browser's tabs and toolbars use up the room.
func findWebArea(_ start: AXUIElement) -> AXUIElement? {
    var queue: [(AXUIElement, Int)] = [(start, 0)]
    var seen = 0
    while !queue.isEmpty && seen < 600 {
        let (element, depth) = queue.removeFirst()
        seen += 1
        let node = axNode(element)
        let role = node != nil ? node!.role : axString(element, kAXRoleAttribute) ?? ""
        if role == "AXWebArea", let frame = node != nil ? node!.frame : axFrame(element), frame.width > 80, frame.height > 80 { return element }
        if depth < 14 { queue.append(contentsOf: (node != nil ? node!.children : axChildren(element)).prefix(40).map { ($0, depth + 1) }) }
    }
    return nil
}
let interestingRoles: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab", "AXCell", "AXStaticText", "AXComboBox", "AXSearchField", "AXHeading", "AXImage", "AXSlider", "AXDisclosureTriangle", "AXMenuItem", "AXRow"]
// Breadth first below `start`: what can be pressed or read and is really on screen (inside `visible`). What lies
// outside (further down a scrolled page) is counted, not listed: clicking it would hit something else.
func collectElements(_ start: AXUIElement, limit: Int, visible: CGRect, skip: AXUIElement? = nil, into items: inout [[String: Any]]) -> Int {
    var queue: [(AXUIElement, Int)] = [(start, 0)]
    var hidden = 0, visited = 0
    let cap = items.count + limit
    while !queue.isEmpty && items.count < cap && visited < 2500 {
        let (element, depth) = queue.removeFirst()
        visited += 1
        if let skip, CFEqual(element, skip) { continue }
        // One round trip for the whole element; the old way, call by call, only where an app refuses that.
        let node = axNode(element)
        let role = node != nil ? node!.role : axString(element, kAXRoleAttribute) ?? ""
        if interestingRoles.contains(role), role != "AXRow", let frame = node != nil ? node!.frame : axFrame(element), frame.width > 2, frame.height > 2 {
            let isField = role.hasPrefix("AXText") || role == "AXSearchField" || role == "AXComboBox"
            let title = node != nil ? node!.title : axString(element, kAXTitleAttribute)
            let described = node != nil ? node!.description : axString(element, kAXDescriptionAttribute)
            // What a text says is asked for only when it has no name of its own.
            let named = [title, described].compactMap { $0 }.first { !$0.isEmpty }
            var label = named ?? (role == "AXStaticText" ? axString(element, kAXValueAttribute) ?? "" : "")
            // A field without a name is told by what stands in it (or its placeholder), so it can be recognised.
            if label.isEmpty && isField { label = [axString(element, kAXPlaceholderValueAttribute), axString(element, kAXValueAttribute)].compactMap { $0 }.first { !$0.isEmpty } ?? "" }
            if !label.isEmpty || isField {
                if frame.intersects(visible) && frame.midX >= visible.minX && frame.midX <= visible.maxX && frame.midY >= visible.minY && frame.midY <= visible.maxY {
                    items.append(["role": String(role.dropFirst(2)), "label": String(label.prefix(80)), "x": Int(frame.midX), "y": Int(frame.midY), "w": Int(frame.width), "h": Int(frame.height)])
                } else { hidden += 1 }
            }
        }
        guard depth < 40 else { continue }
        queue.append(contentsOf: (node != nil ? node!.children : axChildren(element)).prefix(120).map { ($0, depth + 1) })
    }
    return hidden
}
func listElements(_ id: Int) {
    guard !IsSecureEventInputEnabled(), let app = NSWorkspace.shared.frontmostApplication else { emit(["type": "elements", "id": id, "items": []]); return }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetMessagingTimeout(root, 0.4)
    var windowValue: CFTypeRef?
    AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &windowValue)
    let start = (windowValue as! AXUIElement?) ?? root
    // Only what is inside the window and on a screen counts as visible.
    let screens = NSScreen.screens.reduce(CGRect.null) { $0.union(CGRect(x: $1.frame.minX, y: 0, width: $1.frame.width, height: $1.frame.height + abs($1.frame.minY) + 4000)) }
    let visible = (windowValue != nil ? axFrame(start) : nil) ?? (screens.isNull ? CGRect(x: 0, y: 0, width: 10000, height: 10000) : screens)
    var items: [[String: Any]] = []
    var hidden = 0, url = ""
    if let web = findWebArea(start) {
        url = axURL(web) ?? ""
        let area = (axFrame(web) ?? visible).intersection(visible)
        hidden += collectElements(web, limit: 150, visible: area.isNull ? visible : area, into: &items)
        _ = collectElements(start, limit: 60, visible: visible, skip: web, into: &items)
    } else {
        hidden += collectElements(start, limit: 200, visible: visible, into: &items)
    }
    let title = windowValue.map { axString($0 as! AXUIElement, kAXTitleAttribute) ?? "" } ?? ""
    emit(["type": "elements", "id": id, "app": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "window": title, "items": items, "url": url, "hidden": hidden,
          "frame": [Int(visible.minX), Int(visible.minY), Int(visible.width), Int(visible.height)]])
}
// Where pieces of the captured selection stand on the screen: for every [offset, length] inside the selection the
// rectangle of that text (global points), or null. This is how a correction is shown at the very word.
func rangeBounds(_ id: Int, targetID: Int, pieces: [[Int]]) {
    guard !IsSecureEventInputEnabled(), let target = capturedTargets[targetID], let field = target.field, let selection = target.range else { emit(["type": "bounds", "id": id, "rects": []]); return }
    AXUIElementSetMessagingTimeout(field, 0.3)
    var rects: [Any] = []
    for piece in pieces.prefix(60) {
        guard piece.count == 2, piece[0] >= 0, piece[1] >= 0, piece[0] + piece[1] <= selection.length else { rects.append(NSNull()); continue }
        // An empty piece (something is inserted here) is told by the character before or after it.
        var range = CFRange(location: selection.location + piece[0], length: max(1, piece[1]))
        var before = false
        if piece[1] == 0 { if piece[0] > 0 { range.location -= 1; before = true } }
        var bounds: CFTypeRef?
        guard let value = AXValueCreate(.cfRange, &range),
              AXUIElementCopyParameterizedAttributeValue(field, kAXBoundsForRangeParameterizedAttribute as CFString, value, &bounds) == .success,
              let bounds, CFGetTypeID(bounds) == AXValueGetTypeID() else { rects.append(NSNull()); continue }
        var rect = CGRect.zero
        guard AXValueGetValue(bounds as! AXValue, .cgRect, &rect), rect.width > 0, rect.height > 0 else { rects.append(NSNull()); continue }
        if piece[1] == 0 { rects.append([Int(before ? rect.maxX : rect.minX), Int(rect.minY), 0, Int(rect.height)]) }
        else { rects.append([Int(rect.minX), Int(rect.minY), Int(rect.width), Int(rect.height)]) }
    }
    emit(["type": "bounds", "id": id, "rects": rects])
}
// Reads the words in a picture of the screen, each with its place (for corrections drawn at the words in apps
// that do not tell where a word stands). On this Mac only: Apple's own text recognition, nothing is sent anywhere.
// Replies {type: "acted", id, ok, width, height, words: [[text, x, y, w, h], ...]} in pixels of the picture, from
// the top left, in reading order.
func readWords(_ id: Int, path: String) {
    DispatchQueue.global(qos: .userInitiated).async {
        func fail() { DispatchQueue.main.async { emit(["type": "acted", "id": id, "ok": false, "words": []]) } }
        guard let image = NSImage(contentsOfFile: path), let picture = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail(); return }
        let width = Double(picture.width), height = Double(picture.height)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["de-DE", "en-US"]
        request.usesLanguageCorrection = false
        guard (try? VNImageRequestHandler(cgImage: picture, options: [:]).perform([request])) != nil, let lines = request.results else { fail(); return }
        var words: [[Any]] = []
        for line in lines {
            guard let read = line.topCandidates(1).first else { continue }
            let text = read.string
            text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .byWords) { word, range, _, _ in
                guard let word, !word.isEmpty, let box = try? read.boundingBox(for: range)?.boundingBox else { return }
                // Vision counts from the bottom left, in parts of the picture.
                words.append([word, Int(box.minX * width), Int((1 - box.maxY) * height), Int(box.width * width), Int(box.height * height)])
            }
        }
        // Reading order: lines from the top, words from the left (Vision gives blocks in its own order).
        let rows = words.sorted { a, b in
            let ay = a[2] as! Int, by = b[2] as! Int, ah = a[4] as! Int
            return abs(ay - by) > max(6, ah / 2) ? ay < by : (a[1] as! Int) < (b[1] as! Int)
        }
        DispatchQueue.main.async { emit(["type": "acted", "id": id, "ok": true, "width": Int(width), "height": Int(height), "words": Array(rows.prefix(4000))]) }
    }
}
func click(_ x: Double, _ y: Double) {
    let point = CGPoint(x: x, y: y)
    let source = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(30_000)
    }
}
func typeText(_ text: String, softBreaks: Bool = false) {
    let source = CGEventSource(stateID: .hidSystemState)
    // A tab or a line break in the text is the real key: that is how a table is filled cell by cell
    // (tab: next column, return: next row) and how a new paragraph starts.
    var run = ""
    func flush() {
        guard !run.isEmpty else { return }
        let units = Array(run.utf16)
        for chunk in stride(from: 0, to: units.count, by: 20).map({ Array(units[$0..<min($0 + 20, units.count)]) }) {
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
                event?.post(tap: .cghidEventTap)
            }
            usleep(8_000)
        }
        run = ""
    }
    for character in text {
        if character == "\t" || character == "\n" {
            flush()
            usleep(40_000)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: character == "\t" ? 48 : 36, keyDown: down)
                // Shift + Return is a new line without sending, in chats as in documents.
                if softBreaks, character == "\n" { event?.flags = .maskShift }
                event?.post(tap: .cghidEventTap)
            }
            usleep(60_000)
        } else { run.append(character) }
    }
    flush()
}
let KEYS: [String: CGKeyCode] = ["return": 36, "enter": 76, "tab": 48, "space": 49, "delete": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "c": 8, "f": 3, "l": 37, "n": 45, "s": 1, "t": 17, "v": 9, "w": 13, "z": 6]
// Letters by the active keyboard layout, not the US key position: on a German keyboard cmd+z must hit
// the key labelled Z (the US position of Z is Y there).
func layoutKeyCode(_ character: String) -> CGKeyCode? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    return data.withUnsafeBytes { raw -> CGKeyCode? in
        guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
        for code in 0..<128 {
            var dead: UInt32 = 0, length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
            if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length).lowercased() == character.lowercased() { return CGKeyCode(code) }
        }
        return nil
    }
}
func pressKey(_ combo: String) -> Bool {
    let parts = combo.lowercased().split(separator: "+").map(String.init)
    guard let key = parts.last, let code = (key.count == 1 ? layoutKeyCode(key) : nil) ?? KEYS[key] else { return false }
    var flags: CGEventFlags = []
    for part in parts.dropLast() {
        switch part { case "cmd": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt", "option": flags.insert(.maskAlternate); case "ctrl": flags.insert(.maskControl); default: return false }
    }
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down); event?.flags = flags; event?.post(tap: .cghidEventTap) }
    return true
}
// More ways to operate an app, each only after the person confirmed the plan in the notch.
func mouse(_ x: Double, _ y: Double) -> CGPoint {
    // -1 -1 means: where the pointer is now.
    if x < 0 || y < 0 { return CGEvent(source: nil)?.location ?? .zero }
    return CGPoint(x: x, y: y)
}
func clickTimes(_ x: Double, _ y: Double, count: Int, right: Bool = false) {
    let point = mouse(x, y), source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    for click in 1...count {
        for type in right ? [CGEventType.rightMouseDown, .rightMouseUp] : [CGEventType.leftMouseDown, .leftMouseUp] {
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: right ? .right : .left)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            event?.post(tap: .cghidEventTap)
            usleep(20_000)
        }
    }
}
func scroll(_ x: Double, _ y: Double, _ dx: Int32, _ dy: Int32) {
    let point = mouse(x, y), source = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(30_000)
    // In small steps, so apps animate it like a real scroll.
    let steps = max(1, Int(max(abs(dx), abs(dy))))
    for _ in 0..<steps {
        CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy == 0 ? 0 : (dy > 0 ? -3 : 3), wheel2: dx == 0 ? 0 : (dx > 0 ? -3 : 3), wheel3: 0)?.post(tap: .cghidEventTap)
        usleep(25_000)
    }
}
func drag(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
    let source = CGEventSource(stateID: .hidSystemState), from = CGPoint(x: x1, y: y1), to = CGPoint(x: x2, y: y2)
    CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    for step in 1...20 {
        let t = Double(step) / 20, point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(15_000)
    }
    CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
}
// Apps by their visible name: brought to the front, or asked to quit (they still ask to save).
func runningApp(_ name: String) -> NSRunningApplication? {
    // The exact name first, then the short one ("Excel" for Microsoft Excel), then the bundle identifier.
    let wanted = name.lowercased()
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if let exact = apps.first(where: { ($0.localizedName ?? "").lowercased() == wanted }) { return exact }
    guard wanted.count >= 3 else { return nil }
    let partial = apps.filter { ($0.localizedName ?? "").lowercased().contains(wanted) || wanted.contains(($0.localizedName ?? "\u{0}").lowercased()) }
    if partial.count == 1 { return partial[0] }
    let byBundle = apps.filter { ($0.bundleIdentifier ?? "").lowercased().hasSuffix("." + wanted.replacingOccurrences(of: " ", with: "")) }
    return byBundle.count == 1 ? byBundle[0] : nil
}


// Reliable acting (docs/mac-steuerung.md): the element under a point does its own action (AXPress, AXValue)
// instead of a synthetic mouse click; the caller falls back to the mouse when this returns false.
func elementAt(_ x: Double, _ y: Double) -> AXUIElement? {
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &element) == .success else { return nil }
    return element
}
func parentOf(_ element: AXUIElement) -> AXUIElement? {
    var parent: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &parent) == .success, let parent else { return nil }
    return (parent as! AXUIElement)
}
func isSecure(_ element: AXUIElement) -> Bool {
    let role = axString(element, kAXRoleAttribute) ?? "", subrole = axString(element, kAXSubroleAttribute) ?? ""
    return role == "AXSecureTextField" || subrole == "AXSecureTextField"
}
func pressAt(_ x: Double, _ y: Double) -> Bool {
    guard var current = elementAt(x, y) else { return false }
    for _ in 0..<5 {
        if isSecure(current) { return false }
        var names: CFArray?
        if AXUIElementCopyActionNames(current, &names) == .success, let list = names as? [String], list.contains(kAXPressAction as String) {
            return AXUIElementPerformAction(current, kAXPressAction as CFString) == .success
        }
        guard let parent = parentOf(current) else { return false }
        current = parent
    }
    return false
}
// Sets a text field's value and reads it back; never touches password fields.
func setValueAt(_ x: Double, _ y: Double, _ text: String) -> Bool {
    guard var current = elementAt(x, y) else { return false }
    let editable: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    for _ in 0..<4 {
        if isSecure(current) { return false }
        if editable.contains(axString(current, kAXRoleAttribute) ?? "") { break }
        guard let parent = parentOf(current) else { return false }
        current = parent
    }
    guard editable.contains(axString(current, kAXRoleAttribute) ?? ""), !isSecure(current) else { return false }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(current, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
    AXUIElementSetAttributeValue(current, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard AXUIElementSetAttributeValue(current, kAXValueAttribute as CFString, text as CFString) == .success else { return false }
    return axString(current, kAXValueAttribute) == text
}
// A menu command by its titles, e.g. ["Ablage", "Exportieren als PDF …"], pressed without opening the menu.
func pressMenu(_ path: [String]) -> Bool {
    guard !path.isEmpty, let app = NSWorkspace.shared.frontmostApplication else { return false }
    let norm = { (value: String) in value.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "").trimmingCharacters(in: .whitespaces) }
    var barValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXMenuBarAttribute as CFString, &barValue) == .success, let barValue else { return false }
    var current = barValue as! AXUIElement
    for (index, title) in path.enumerated() {
        var children: CFTypeRef?
        guard AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &children) == .success, var list = children as? [AXUIElement] else { return false }
        // Menu bar items and menu items hold their entries in one child menu.
        if list.count == 1, (axString(list[0], kAXRoleAttribute) ?? "") == "AXMenu" {
            var inner: CFTypeRef?
            if AXUIElementCopyAttributeValue(list[0], kAXChildrenAttribute as CFString, &inner) == .success, let items = inner as? [AXUIElement] { list = items }
        }
        guard let item = list.first(where: { norm(axString($0, kAXTitleAttribute) ?? "") == norm(title) }) else { return false }
        if index == path.count - 1 {
            var enabled: CFTypeRef?
            if AXUIElementCopyAttributeValue(item, kAXEnabledAttribute as CFString, &enabled) == .success, (enabled as? Bool) == false { return false }
            return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
        }
        current = item
    }
    return false
}


// A menu command by its keyboard shortcut (cmd + one character), independent of the app's language:
// "Z" finds Undo ("Eingabe widerrufen", "Undo Typing" …) in the frontmost app and presses it.
func pressMenuShortcut(_ key: String) -> Bool {
    guard let app = NSWorkspace.shared.frontmostApplication else { return false }
    var barValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier), kAXMenuBarAttribute as CFString, &barValue) == .success, let barValue else { return false }
    func children(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success, let list = value as? [AXUIElement] else { return [] }
        return list
    }
    for barItem in children(barValue as! AXUIElement) {
        for menu in children(barItem) {
            for item in children(menu) {
                var char: CFTypeRef?, modifiers: CFTypeRef?, enabled: CFTypeRef?
                guard AXUIElementCopyAttributeValue(item, kAXMenuItemCmdCharAttribute as CFString, &char) == .success, (char as? String)?.uppercased() == key.uppercased() else { continue }
                AXUIElementCopyAttributeValue(item, kAXMenuItemCmdModifiersAttribute as CFString, &modifiers)
                guard ((modifiers as? Int) ?? 0) == 0 else { continue }
                if AXUIElementCopyAttributeValue(item, kAXEnabledAttribute as CFString, &enabled) == .success, (enabled as? Bool) == false { return false }
                return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
            }
        }
    }
    return false
}

// Typing without keystrokes: the text goes in at the caret of the focused field (AXSelectedText), which is
// layout-independent and checkable; the caller falls back to keystrokes when a field refuses.
func focusedElement() -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &value) == .success, let value,
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func insertAtCaret(_ text: String) -> Bool {
    guard !IsSecureEventInputEnabled(), let field = focusedElement(), !isSecure(field) else { return false }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
    let before = axString(field, kAXValueAttribute)
    guard AXUIElementSetAttributeValue(field, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { return false }
    // Some fields accept the call and ignore it: only a changed value counts.
    let after = axString(field, kAXValueAttribute)
    return before == nil || after != before
}
// What the focused field holds now (the end of it), to check that typed text really arrived.
func focusedReport(_ id: Int) {
    guard let field = focusedElement(), !isSecure(field) else { emit(["type": "focused", "id": id, "known": false]); return }
    let value = axString(field, kAXValueAttribute)
    emit(["type": "focused", "id": id, "known": value != nil, "role": axString(field, kAXRoleAttribute) ?? "", "value": String((value ?? "").suffix(2000))])
}
func act(_ id: Int, _ body: () -> Bool) {
    guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { emit(["type": "acted", "id": id, "ok": false, "reason": "not-allowed"]); return }
    emit(["type": "acted", "id": id, "ok": body()])
}

// What stands at a point of the screen, in words: the element under it, or the nearest one above it that has a name
// (a button's title, a link's text, a field's label). Read over Accessibility on this Mac; never in secure input.
func labelAt(_ id: Int, _ x: Double, _ y: Double) {
    guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(), var current = elementAt(x, y) else { emit(["type": "at", "id": id, "label": "", "role": ""]); return }
    for _ in 0..<5 {
        if isSecure(current) { break }
        let role = axString(current, kAXRoleAttribute) ?? ""
        for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
            if let text = axString(current, attribute)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                emit(["type": "at", "id": id, "label": String(text.prefix(90)), "role": role]); return
            }
        }
        guard let parent = parentOf(current) else { break }
        current = parent
    }
    emit(["type": "at", "id": id, "label": "", "role": ""])
}

var lastHapticAt = -Double.infinity
func handle(_ command: String) {
    if command == "fn-swallow" { swallowFn = true; return }
    if command == "fn-keep" { swallowFn = false; return }
    if command == "return-own-on" { ownReturn = true; return }
    if command == "return-own-off" { ownReturn = false; return }
    if command == "emoji-key-on" { emojiKey = true; return }
    if command == "emoji-key-off" { emojiKey = false; return }
    if command.hasPrefix("permissions ") {
        let rawID = command.dropFirst(12)
        guard let id = Int(rawID), id > 0 else { return }
        if tap == nil && mayListen() { _ = startTap() }
        var reply = permissions()
        reply["id"] = id
        emit(reply)
        return
    }
    if command.hasPrefix("capture-target "), let id = Int(command.dropFirst(15)) { captureTarget(id); return }
    if command.hasPrefix("read-inserted ") {
        let tokens = command.split(separator: " ")
        if tokens.count == 3, let requestID = Int(tokens[1]), let pasteID = Int(tokens[2]) { readInserted(requestID, pasteID: pasteID) }
        return
    }
    if command.hasPrefix("paste-session ") {
        let tokens = command.split(separator: " ", maxSplits: 4)
        if tokens.count == 5, let id = Int(tokens[1]), let deadline = Double(tokens[2]), let target = Int(tokens[3]),
           let data = Data(base64Encoded: String(tokens[4])), let text = String(data: data, encoding: .utf8) {
            pasteRequestID = id; paste(text, deadline: deadline, targetID: target)
        }
        return
    }
    // Actions: "elements <id>", "click <id> <x> <y>", "type <id> <base64>", "key <id> <combo>".
    let parts = command.split(separator: " ", maxSplits: 3).map(String.init)
    if parts.count >= 2, let id = Int(parts[1]) {
        switch parts[0] {
        case "elements": listElements(id); return
        // Where an app's front window is on the screen (window list, no Accessibility needed): whispertext places the
        // "drag into the list" card beside System Settings with it.
        case "window-of" where parts.count == 3:
            let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: parts[2]).map { $0.processIdentifier })
            let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let window = list.first { ($0[kCGWindowLayer as String] as? Int) == 0 && pids.contains(pid_t(($0[kCGWindowOwnerPID as String] as? Int) ?? -1)) }
            if let box = window?[kCGWindowBounds as String] as? [String: Double] {
                emit(["type": "bounds", "id": id, "rects": [[box["X"] ?? 0, box["Y"] ?? 0, box["Width"] ?? 0, box["Height"] ?? 0]]])
            } else { emit(["type": "bounds", "id": id, "rects": []]) }
            return
        case "at" where parts.count == 4: labelAt(id, Double(parts[2]) ?? 0, Double(parts[3]) ?? 0); return
        case "replace-inserted" where parts.count == 4:
            let pair = parts[3].split(separator: " ").map(String.init)
            guard pair.count == 2, let pasteID = Int(parts[2]), let before = Data(base64Encoded: pair[0]), let after = Data(base64Encoded: pair[1]),
                  let expected = String(data: before, encoding: .utf8), let replacement = String(data: after, encoding: .utf8) else { emit(["type": "acted", "id": id, "ok": false, "reason": "bad-request"]); return }
            replaceInserted(id, pasteID: pasteID, expected: expected, replacement: replacement); return
        case "ocr" where parts.count == 3:
            guard let data = Data(base64Encoded: parts[2]), let path = String(data: data, encoding: .utf8) else { emit(["type": "acted", "id": id, "ok": false, "words": []]); return }
            readWords(id, path: path); return
        case "bounds" where parts.count == 4:
            guard let targetID = Int(parts[2]), let data = Data(base64Encoded: parts[3]), let pieces = try? JSONSerialization.jsonObject(with: data) as? [[Int]] else { emit(["type": "bounds", "id": id, "rects": []]); return }
            rangeBounds(id, targetID: targetID, pieces: pieces); return
        case "click" where parts.count == 4: act(id) { guard let x = Double(parts[2]), let y = Double(parts[3]) else { return false }; click(x, y); return true }; return
        case "type" where parts.count == 3: act(id) { guard let data = Data(base64Encoded: parts[2]), let text = String(data: data, encoding: .utf8) else { return false }; typeText(text); return true }; return
        case "key" where parts.count == 3: act(id) { pressKey(parts[2]) }; return
        case "dclick" where parts.count == 3: act(id) { guard let point = Optional(parts[2].split(separator: ",").compactMap { Double($0) }), point.count == 2 else { return false }; clickTimes(point[0], point[1], count: 2); return true }; return
        case "rclick" where parts.count == 3: act(id) { guard let point = Optional(parts[2].split(separator: ",").compactMap { Double($0) }), point.count == 2 else { return false }; clickTimes(point[0], point[1], count: 1, right: true); return true }; return
        case "scroll" where parts.count == 4: act(id) {
            let values = (parts[2] + "," + parts[3]).split(separator: ",").compactMap { Double($0) }
            guard values.count == 4 else { return false }
            scroll(values[0], values[1], Int32(max(-20, min(20, values[2]))), Int32(max(-20, min(20, values[3])))); return true }; return
        case "drag" where parts.count == 4: act(id) {
            let values = (parts[2] + "," + parts[3]).split(separator: ",").compactMap { Double($0) }
            guard values.count == 4 else { return false }
            drag(values[0], values[1], values[2], values[3]); return true }; return
        case "press" where parts.count == 4: act(id) { guard let x = Double(parts[2]), let y = Double(parts[3]) else { return false }; return pressAt(x, y) }; return
        case "setv" where parts.count == 4: act(id) { let point = parts[2].split(separator: ",").compactMap { Double($0) }; guard point.count == 2, let data = Data(base64Encoded: parts[3]), let text = String(data: data, encoding: .utf8) else { return false }; return setValueAt(point[0], point[1], text) }; return
        case "menukey" where parts.count == 3: act(id) { pressMenuShortcut(parts[2]) }; return
        case "insert" where parts.count == 3: act(id) { guard let data = Data(base64Encoded: parts[2]), let text = String(data: data, encoding: .utf8) else { return false }; return insertAtCaret(text) }; return
        case "focused": focusedReport(id); return
        case "menu" where parts.count == 3: act(id) { guard let data = Data(base64Encoded: parts[2]), let path = try? JSONSerialization.jsonObject(with: data) as? [String] else { return false }; return pressMenu(path) }; return
        case "quit" where parts.count == 3: act(id) { guard let data = Data(base64Encoded: parts[2]), let name = String(data: data, encoding: .utf8), let app = runningApp(name) else { return false }; return app.terminate() }; return
        case "activate" where parts.count == 3: act(id) { guard let data = Data(base64Encoded: parts[2]), let name = String(data: data, encoding: .utf8), let app = runningApp(name) else { return false }; return app.activate() }; return
        default: break
        }
    }
    if command.hasPrefix("paste-text ") {
        let parts = command.dropFirst(11).split(separator: " ", maxSplits: 2)
        if parts.count == 3, let id = Int(parts[0]), let deadline = Double(parts[1]), let data = Data(base64Encoded: String(parts[2])), let text = String(data: data, encoding: .utf8) { pasteRequestID = id; paste(text, deadline: deadline) }
        else { pasteReply([ "ok": false]) }
        return
    }
    switch command {
    case "start":
        guard mayListen() else { emit(permissions()); return }
        emit(["type": "started", "ok": tap != nil || startTap()])
    case "haptic":
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastHapticAt >= 0.5 else { return }
        lastHapticAt = now
        NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    case "capture-target": captureTarget()
    case "clear-target": targetField = nil; targetPID = nil; capturedTargets.removeAll(); insertedRegions.removeAll(); restoreClipboard()
    case "read-inserted": readInserted()
    case "permissions":
        if tap == nil && mayListen() { _ = startTap() }
        emit(permissions())
    case "ask-input":
        if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
        if tap == nil && mayListen() { _ = startTap() }
        emit(permissions())
    case "ask-accessibility":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        if tap == nil && mayListen() { _ = startTap() }
        emit(permissions())
    case "quit": restoreClipboard(); exit(0)
    default: break
    }
}

// Commands arrive on a background thread and run on the main run loop, where the tap lives.
Thread.detachNewThread {
    while let line = readLine() {
        let command = line.trimmingCharacters(in: .whitespaces)
        DispatchQueue.main.async { handle(command) }
    }
    DispatchQueue.main.async { restoreClipboard(); exit(0) } // The app went away.
}

signal(SIGTERM, SIG_IGN)
let exitSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
exitSignal.setEventHandler { restoreClipboard(); exit(0) }
exitSignal.resume()
// Which app is in front: told on every change, so Studymut can give the focus back to where the person was.
// Whether that app shows a window at all: with none, the screen is as good as the bare desktop.
func hasWindow(_ pid: pid_t) -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return true }
    return list.contains { window in
        guard (window[kCGWindowOwnerPID as String] as? pid_t) == pid, (window[kCGWindowLayer as String] as? Int) == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any] else { return false }
        return (bounds["Height"] as? CGFloat ?? 0) > 40 && (bounds["Width"] as? CGFloat ?? 0) > 40
    }
}
var frontKey = ""
func emitFront(_ app: NSRunningApplication?, onlyIfChanged: Bool = false) {
    guard let app else { return }
    let windows = hasWindow(app.processIdentifier)
    let key = "\(app.processIdentifier):\(windows)"
    if onlyIfChanged && key == frontKey { return }
    frontKey = key
    emit(["type": "front", "bundle": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "windows": windows])
}
// A window closing or opening tells nobody: looked at once a second, told only when it changed.
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in emitFront(NSWorkspace.shared.frontmostApplication, onlyIfChanged: true) }
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    emitFront(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
emit(permissions())
emitFront(NSWorkspace.shared.frontmostApplication)
CFRunLoopRun()
