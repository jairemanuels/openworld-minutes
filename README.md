# openworld minutes

Private meeting notes that run entirely in your browser. Record a meeting (microphone, optionally plus tab or system audio for online calls) or upload a recording, and get a timestamped transcript, a summary, action items and exports. Speech recognition is OpenAI's Whisper model running locally through [transformers.js](https://github.com/huggingface/transformers.js) on WebGPU or WebAssembly.

openworld minutes is an open-source alternative to tools like Fireflies.ai and Otter.ai, built for people who do not want their meetings on someone else's server.

**Live demo:** https://jairemanuels.github.io/openworld-minutes/

## Privacy

- **Audio never leaves your device.** There is no backend. The page is static files on GitHub Pages; the Whisper model is downloaded once from the Hugging Face Hub and cached by your browser, then all processing happens on your machine.
- **Meetings are stored locally** in your browser's IndexedDB (title, date, duration, transcript, summary and the audio itself). Clearing site data removes them.
- **AI summaries are opt-in.** If you paste your own OpenAI-compatible or Anthropic API key in Settings, it is stored only in `localStorage` and the *transcript text* (never the audio) is sent only to the endpoint you chose, when you click "Generate AI summary". Without a key nothing is sent anywhere.

## Features

- **Record** from the microphone with a timer, pause/resume and live level meters.
- **Capture online meetings**: optionally mix in tab or system audio via screen sharing (`getDisplayMedia`), so the other participants in a Meet, Zoom or Teams web call are recorded too.
- **Upload** audio or video files: mp3, m4a, wav, webm, mp4, ogg and more (anything your browser can decode).
- **Local Whisper transcription** with WebGPU when available and a WASM fallback. Model picker: tiny (fast), base (default) and small (most accurate). Model download progress is shown.
- **Dutch and English**, with automatic language detection (Whisper's own language token, restricted to NL/EN) or a manual override.
- **Long recordings**: audio is decoded to 16 kHz mono and split into ~2 minute parts at quiet points, each processed in 30 second windows with a 5 second stride. A 60 minute meeting works; the transcript fills in part by part.
- **Transcript view** with timestamps, click a line to seek the player, follow-along highlighting, search with match navigation, and inline editing.
- **Local summary** with no key needed: extractive key points, action items detected with Dutch and English heuristics (owners and due dates where mentioned) and key topics.
- **AI summary** with your own key: overview, decisions, action items with owner, open questions. Works with OpenAI, any OpenAI-compatible API that allows browser requests (OpenRouter, Groq, local Ollama or LM Studio, ...) and Anthropic.
- **Meetings library** in IndexedDB with filter, rename and delete.
- **Export** as Markdown, plain text or SRT subtitles, copy to clipboard, or share as a `.md` file.

## Limitations

- **No speaker diarization yet.** The transcript is not split by speaker.
- **First run downloads the model**: roughly 40 MB (tiny), 80 MB (base) or 250 MB (small). It is cached afterwards.
- **Speed depends on your hardware.** WebGPU (recent Chrome/Edge) is much faster than the WASM fallback. On CPU, base runs at roughly real-time / 4 on a modern laptop.
- **Tab/system audio capture** depends on the browser and OS: Chrome and Edge can share tab audio everywhere and full system audio on Windows and ChromeOS; Firefox and Safari do not share audio from `getDisplayMedia`.
- **Memory**: very long recordings are held in memory as 16 kHz float samples (about 230 MB per hour) during transcription.
- The tab must stay open while transcribing.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/openworld-minutes/
npm test           # vitest unit tests
npm run build      # static build in dist/
npm run deploy     # build and publish dist/ to the gh-pages branch
```

### End-to-end check in Node

`scripts/e2e-node.mjs` runs the same decode helpers and chunked transcription driver as the browser worker, against a real audio file, using onnxruntime-node:

```bash
# needs ffmpeg on PATH; any speech recording works
node scripts/e2e-node.mjs path/to/meeting.mp3 base auto
```

Example run on a 60 second English sample: language detected as `en` (p = 1.00), 148 words in 15 timestamped segments, real-time factor 0.21 on CPU. A Dutch sample was detected as `nl` (p = 0.998) and transcribed with action items extracted.

## Stack

- Vanilla JavaScript, [Vite](https://vitejs.dev/), no UI framework
- [@huggingface/transformers](https://github.com/huggingface/transformers.js) (transformers.js v3) with ONNX Runtime Web, in a Web Worker
- Whisper models from [onnx-community](https://huggingface.co/onnx-community) (tiny, base, small)
- Web Audio API, MediaRecorder, getDisplayMedia, IndexedDB
- [Vitest](https://vitest.dev/) for unit tests
- Geist and Geist Mono typefaces

## Roadmap

- Speaker labels (diarization)
- A meeting bot that can join Zoom, Google Meet and Microsoft Teams calls
- Self-hosted server mode with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) for teams and larger models
- More languages for the local action-item heuristics

## License

[MIT](LICENSE) © 2026 Jaïr Emanuels / Nodient

Not affiliated with Fireflies.ai or Otter.ai.
