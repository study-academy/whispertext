# whispertext

Diktieren auf dem Mac, überall wo du tippen kannst. Kostenlos, ohne Konto, die Spracherkennung läuft komplett auf deinem Mac. Kein Ton und kein Text verlässt das Gerät.

## Installieren

1. `whispertext-macOS-arm64.dmg` aus dem [neuesten Release](https://github.com/study-academy/whispertext/releases/latest) laden (Apple Silicon, M1 oder neuer).
2. whispertext in den Programme-Ordner ziehen und öffnen.
3. Die App führt dich durch zwei Freigaben (Mikrofon, Bedienungshilfen) und eine kurze Einführung.

## Bedienung

| | |
|---|---|
| `fn` halten und sprechen | Text erscheint dort, wo der Cursor steht |
| `fn` zweimal | freies Sprechen ohne Halten, `⏎` fertig, `esc` verwerfen |
| `⌃⌘V` | letztes Diktat nochmal einfügen |

Fährst du mit der Maus auf den Strich oben in der Mitte, erscheinen zwei Symbole:

- **Verlauf**: frühere Diktate. Klick zum Aufklappen und Anhören, `⌘F` sucht.
- **Wörter**: Namen, Korrekturen und Textbausteine. `Gehört → Wird zu`. Ein langer Text unter einem kurzen Wort wird beim Diktieren dieses Worts eingefügt. whispertext lernt auch selbst dazu, wenn du einen diktierten Text korrigierst.

Die Einführung lässt sich über das Symbol in der Menüleiste wiederholen.

## Entwickeln

```bash
npm install
npm test
npm start
npm run dist:mac
```

`dist:mac` braucht das Parakeet-Modell unter `native/models/parakeet-tdt-0.6b-v3` (siehe `native/parakeet/PROVENANCE.md`) und baut `dist/whispertext-macOS-arm64.dmg`.

Aufbau:

- `main/`: Electron-Hauptprozess (Fenster unter der Notch, Freigaben, Diktat, Wörter, Verlauf)
- `core/`: reine Logik (Tastengesten, Text-Formatierung, Wortschatz)
- `ui/`: Strich, Zeile, Übungsfeld
- `native/mac/`: Swift-Helfer für `fn`, Einfügen und Fensterpositionen
- `native/parakeet/`: lokale Spracherkennung (Parakeet TDT v3, CoreML)

Modellgewichte: NVIDIA Parakeet TDT 0.6B v3, CC BY 4.0, CoreML-Umwandlung von FluidInference.
