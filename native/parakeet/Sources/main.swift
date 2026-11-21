import Foundation
import FluidAudio

let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    outputLock.lock(); defer { outputLock.unlock() }
    if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
// Only model files persist. Audio arrives as 16 kHz mono Float32 samples and stays in memory.
@main
struct StudymutParakeet {
static func main() async {
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
ModelRegistry.revisionOverrides = ["FluidInference/parakeet-tdt-0.6b-v3-coreml": "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe"]
var manager: AsrManager?
while let line = readLine() {
    var id = 0
    do {
        guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        id = request["id"] as? Int ?? 0
        let setup = request["type"] as? String == "setup"
        // "load" warms the model at launch, so the first dictation does not wait for CoreML.
        let warm = request["type"] as? String == "load"
        if manager == nil {
            let models: AsrModels
            let modelDirectory = directory.deletingLastPathComponent().appendingPathComponent("parakeet-tdt-0.6b-v3")
            if setup {
                let requestID = id
                models = try await AsrModels.downloadAndLoad(to: directory, version: .v3, encoderPrecision: .int8V2, progressHandler: { progress in
                    let phase: String
                    switch progress.phase {
                    case .listing: phase = "Dateiliste prüfen"
                    case .downloading: phase = "Modelldateien laden"
                    case .compiling: phase = "Modell vorbereiten"
                    }
                    emit(["id":requestID,"type":"progress","phase":phase,"fraction":progress.fractionCompleted])
                })
            }
            else {
                let revision = try String(contentsOf: modelDirectory.appendingPathComponent(".fluidaudio-revision"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
                guard revision == "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe" else { throw NSError(domain:"model-revision",code:1) }
                // WT_UNITS=cpu: the copy that takes dictations while macOS prepares the Neural Engine once (dictation.js).
                models = try AsrModels.loadLocal(from: modelDirectory, version: .v3, configuration: ProcessInfo.processInfo.environment["WT_UNITS"] == "cpu" ? MLModelConfigurationUtils.defaultConfiguration(computeUnits: .cpuOnly) : nil, encoderPrecision: .int8V2, encoderComputeUnits: ProcessInfo.processInfo.environment["WT_UNITS"] == "cpu" ? .cpuOnly : nil)
            }
            let loaded = AsrManager(config: .default)
            try await loaded.loadModels(models)
            manager = loaded
        }
        if setup || warm {
            // Loading is not enough: CoreML prepares the model for the Neural Engine on its first real prediction
            // (50 s after a fresh install, 4 s on a normal launch, measured 21.11.2026). One second of silence runs
            // through it here, at launch, so the person's first dictation is as fast as every later one.
            var warmState = try TdtDecoderState()
            _ = try? await manager!.transcribe([Float](repeating: 0, count: 16000), decoderState: &warmState)
            emit(["id": id, "ready": true]); continue
        }
        guard let encoded = request["audio"] as? String, let bytes = Data(base64Encoded: encoded), bytes.count % 4 == 0, bytes.count <= 16000 * 4 * 120 else { throw NSError(domain: "audio", code: 1) }
        let samples = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        guard samples.allSatisfy({ $0.isFinite }) else { throw NSError(domain: "audio", code: 2) }
        var decoderState = try TdtDecoderState()
        let result = try await manager!.transcribe(samples, decoderState: &decoderState)
        // When each word was said (the recogniser knows it anyway): pieces that begin a word start with "▁" or a space.
        // Studymut uses it to tell which words belong to which place the person pointed at.
        var words: [[Any]] = []
        for timing in result.tokenTimings ?? [] {
            let piece = timing.token
            let starts = piece.hasPrefix("▁") || piece.hasPrefix(" ")
            let text = piece.replacingOccurrences(of: "▁", with: "").trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            if starts || words.isEmpty { words.append([text, Int(timing.startTime * 1000), Int(timing.endTime * 1000)]) }
            else { var last = words.removeLast(); last[0] = (last[0] as? String ?? "") + text; last[2] = Int(timing.endTime * 1000); words.append(last) }
        }
        emit(["id": id, "text": result.text, "words": words, "processingMs": result.processingTime * 1000, "durationMs": result.duration * 1000])
    } catch { emit(["id": id, "error": String(describing: error)]) }
}

}
}
