# traffic-chimes

Serves the audio of [The 101 Plays Itself](https://the-101-plays-itself.netlify.app/)
as a live MP3 stream, so it can play on a Sonos, in VLC, or on any internet-radio
app without a browser.

The site turns a public Caltrans traffic camera on the US-101 in Studio City into
generative music: every car that crosses a virtual line becomes a note. All of the
detection and synthesis happens in the browser, so there is no stream to relay.
This project runs that browser for you.

## How it works

```
Caltrans HLS ─▶ headless Chromium (the site, unmodified)
                   │  AudioContext.destination swapped for a MediaStream tap
                   │  MediaRecorder → Opus/WebM chunks
                   ▼
                Node ──▶ ffmpeg (WebM → MP3) ──▶ HTTP  GET /stream.mp3
```

- Puppeteer opens the site in headless Chromium, waits for the camera, and presses
  **Start listening**. A script injected before the page loads wraps `AudioContext`
  so the page's output lands in a `MediaStreamDestination` we can record.
- The recorded Opus chunks are piped into ffmpeg and re-encoded as constant-bitrate
  MP3, which is fanned out to every connected listener. A two-second ring buffer means
  a new listener hears sound immediately.
- **On demand.** Nothing runs while nobody is listening. The first listener starts the
  page (about 2 seconds to first note); when the last listener leaves, everything shuts
  down after a grace period (`IDLE_SECONDS`, default 60). Silent MP3 frames are sent
  during warm-up so players don't time out.
- A watchdog recycles the page and encoder if audio stops or the video clock freezes,
  with exponential backoff, plus an optional daily reload.

## Run on a Synology NAS (Docker)

Requires Container Manager (x86_64 models) or Docker over SSH.

```sh
# on the NAS, in a folder containing this repo
docker compose up -d --build
docker compose logs -f
```

Or in Container Manager: **Project → Create**, point it at this folder, and it will
pick up `docker-compose.yml`.

Then play `http://<nas-ip>:8000/stream.mp3`. A status page lives at
`http://<nas-ip>:8000/` and JSON health at `/health` (503 when the stream has stalled).

Choose instruments and other settings in `docker-compose.yml`.

## Run locally

Needs Node 20+ and `ffmpeg` on the PATH. Puppeteer downloads its own Chrome.

```sh
npm install
INSTRUMENTS=theremin,glass,marimba npm start
# then open http://localhost:8000/stream.mp3 in VLC, or run:
ffplay http://localhost:8000/stream.mp3
```

`npm run prototype` records 45 seconds straight to `proto.mp3` without the HTTP
server; useful for checking that headless audio capture works on a new machine.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `INSTRUMENTS` | `theremin,glass,marimba` | Comma-separated. Any of: `theremin glass rhodes strings choir flute vibes handpan gamelan harp musicbox marimba kalimba organ sub drums` |
| `PORT` | `8000` | HTTP port |
| `BITRATE` | `128k` | MP3 bitrate (CBR) |
| `OPUS_BITRATE` | `192000` | In-browser capture bitrate before transcoding |
| `IDLE_SECONDS` | `60` | Keep the page alive this long after the last listener leaves |
| `STALL_SECONDS` | `30` | No audio for this long → recycle page + encoder |
| `VIDEO_STALL_SECONDS` | `120` | Video clock frozen this long → recycle (the site's own HLS retry gets first go) |
| `STARTUP_TIMEOUT_SECONDS` | `90` | Max wait for the camera on page open |
| `RELOAD_HOURS` | `24` | Periodic page reload while live, to cap Chromium memory; `0` disables |
| `KILL_BROWSER_WHEN_IDLE` | `false` | Also quit Chromium when idle (saves ~50 MB, adds ~1 s to cold start) |
| `THROTTLE_RAF` | `true` | Cap the page's redraw loop at 20 fps to save CPU (detection already samples at 20 Hz) |
| `PAGE_URL` | the netlify site | Page to render |
| `STREAM_URL` | unset | Override the camera HLS URL (passed to the page as `?stream=`) |
| `STREAM_NAME` | `The 101 Plays Itself` | Sent as the ICY station name |
| `RING_SECONDS` | `2` | Audio kept for late joiners |
| `CHROME_PATH` | auto | Chromium binary; auto-detects `/usr/bin/chromium` in the container |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Endpoints

| Path | What |
| --- | --- |
| `/stream.mp3` (also `/stream`, `/listen`) | The live MP3 stream, with ICY headers |
| `/health` | JSON: state (`idle` / `starting` / `live` / `draining`), listeners, chunk ages, restarts |
| `/` | Tiny status page with an inline player |

## Notes

- Camera and page belong to Caltrans and the site's author respectively; this just
  runs one browser instance, exactly like a person leaving the tab open, and only while
  someone is actually listening.
- The Caltrans stream drops out now and then. The site retries on its own; the watchdog
  here covers the cases it can't.
- CPU: expect a fraction of one core while live (software H.264 decode of a 768x432
  feed plus the synth), and near zero when idle.
