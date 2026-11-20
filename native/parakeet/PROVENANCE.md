# Local ASR runtime

FluidAudio source snapshot: https://github.com/FluidInference/FluidAudio/commit/1b0ed50d686873128a4129b3510ce3914c849bab
The `vendor` sources are copied from that exact revision, with one documented patch: `ModelRegistry.resolveModel` now applies the SDK revision override to direct vocabulary-file requests as well. Upstream Apache-2.0 text is preserved as `vendor/LICENSE-FluidAudio`. The direct build does not define TTS or Diarizer and does not link the optional Rust text processor. Source snapshot is about 4.3 MB; resulting ARM64 helper is about 4 MB. No Python, NeMo environment, package installation or system toolchain changes.

Model: NVIDIA Parakeet TDT 0.6B v3, converted by FluidInference for CoreML.
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml/tree/7dd20fe6b1797d35f5e3307e8b1732d9a178edfe
Weights: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Attribution: NVIDIA / FluidInference. NVIDIA model card describes the multilingual original; FluidInference supplies the int8-linear-v2 CoreML conversion. Only Preprocessor, Encoder_v2 int8-linear, Decoder, JointDecisionv3 and vocabulary are downloaded. SDK repository revision override pins all components, including vocabulary via the one-line resolver fix. The corrected int8-linear-v2 encoder is chosen explicitly: the upstream default `.int8` actually uses older 6-bit-LUT weights, with a documented token-corruption issue #760. The corrected bundle is 632,169,729 bytes (632.17 MB; 20 files, verified against the pinned HuggingFace tree manifest).

Minimum deployment: macOS 14, ARM64. Inputs are 16 kHz mono Float32. V3 performs automatic multilingual recognition and final batch decoding after Fn release. Language selection labels history; it is not a forced language or a detected-language claim. No EOU streaming claim.

Rebuild: from desktop run `npm run build:parakeet`, then `npm run build:mac-helper` and electron-builder. The direct Swift build avoids a locally inconsistent SwiftPM PackageDescription API and does not alter it. `Package.swift` is included as an optional manifest for a healthy toolchain; direct script is authoritative here.
