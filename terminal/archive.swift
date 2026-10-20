// Writes the two archived values a Terminal.app profile stores, as base64 on stdout:
//   swift archive.swift color <hex> <alpha>   an NSColor, for the colors of a profile
//   swift archive.swift bookmark <file>       a bookmark to a file, for BackgroundImageBookmark
// install.sh and the profile generator use it. Apple's Foundation only; nothing is installed.
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: archive.swift color <hex> <alpha> | bookmark <file>\n".data(using: .utf8)!)
    exit(2)
}

var archived: Data?
switch args[1] {
case "color":
    let hex = args[2].trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let alpha = args.count > 3 ? CGFloat(Double(args[3]) ?? 1) : 1
    var value: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&value)
    let color = NSColor(
        srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
        green: CGFloat((value >> 8) & 0xFF) / 255,
        blue: CGFloat(value & 0xFF) / 255,
        alpha: alpha
    )
    archived = try? NSKeyedArchiver.archivedData(withRootObject: color, requiringSecureCoding: false)
case "bookmark":
    let url = URL(fileURLWithPath: args[2])
    if let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        archived = try? NSKeyedArchiver.archivedData(withRootObject: bookmark, requiringSecureCoding: false)
    }
default:
    break
}

guard let out = archived else {
    FileHandle.standardError.write("could not archive \(args[1])\n".data(using: .utf8)!)
    exit(1)
}
print(out.base64EncodedString())
