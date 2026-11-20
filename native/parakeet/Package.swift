// swift-tools-version: 6.0
import PackageDescription
// FluidAudio source snapshot 1b0ed50d686873128a4129b3510ce3914c849bab.
// ASR only: no TTS, diarization, Rust FST binary or Python runtime.
let package = Package(name:"StudymutParakeet", platforms:[.macOS(.v14)], targets:[
 .target(name:"FastClusterWrapper",path:"vendor/FastClusterWrapper",publicHeadersPath:"include"),
 .target(name:"MachTaskSelfWrapper",path:"vendor/MachTaskSelfWrapper",publicHeadersPath:"include"),
 .target(name:"FluidAudio",dependencies:["FastClusterWrapper","MachTaskSelfWrapper"],path:"vendor/FluidAudio",exclude:["ASR/Parakeet/Unified/benchmark.md"]),
 .executableTarget(name:"studymut-parakeet",dependencies:["FluidAudio"],path:"Sources")
],cxxLanguageStandard:.cxx17)
