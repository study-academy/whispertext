import AppKit
import CryptoKit
var digest = SHA256()
for item in NSPasteboard.general.pasteboardItems ?? [] {
    digest.update(data:Data([0]))
    for type in item.types.sorted(by:{$0.rawValue < $1.rawValue}) {
        digest.update(data:Data(type.rawValue.utf8))
        if let bytes=item.data(forType:type){digest.update(data:bytes)}
    }
}
print(digest.finalize().map{String(format:"%02x",$0)}.joined())
