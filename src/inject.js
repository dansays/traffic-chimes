/**
 * Runs inside the page before any of its own scripts (page.evaluateOnNewDocument).
 *
 * 1. Wraps AudioContext so `ctx.destination` is a MediaStreamAudioDestinationNode
 *    we control. The page's audio graph is untouched; it still "hears" a
 *    destination, and we tee the same node into the real output.
 * 2. Starts a MediaRecorder on that stream and ships each Opus/WebM chunk to
 *    Node as base64 through the exposed `__chunk` binding.
 * 3. Optionally throttles requestAnimationFrame (the page redraws canvases on
 *    every frame that nobody will ever see).
 *
 * Config is read from `window.__TC` which Node sets before this runs.
 */
export function injectScript() {
  return `(() => {
    const cfg = Object.assign({ bitrate: 192000, timeslice: 500, throttleRaf: true, rafFps: 20 }, window.__TC || {});
    const log = (...a) => console.log('[tc]', ...a);

    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) { log('no AudioContext'); return; }

    let recorder = null;

    function startRecorder(stream) {
      if (recorder) return;
      const mime = 'audio/webm;codecs=opus';
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) {
        log('MediaRecorder unsupported for', mime); return;
      }
      recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: cfg.bitrate });
      recorder.ondataavailable = async (ev) => {
        if (!ev.data || !ev.data.size) return;
        const buf = new Uint8Array(await ev.data.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        if (window.__chunk) window.__chunk(btoa(s));
      };
      recorder.onerror = (e) => log('recorder error', e.error && e.error.name);
      recorder.start(cfg.timeslice);
      log('recorder started');
    }

    window.__tcNotes = 0; // oscillators started: a cheap "did any car become a note" counter

    class TappedAudioContext extends Real {
      constructor(...args) {
        super(...args);
        this.__tap = null;
      }
      createOscillator() { window.__tcNotes++; return super.createOscillator(); }
      get destination() {
        if (!this.__tap) {

          const tap = super.createMediaStreamDestination();
          // (a MediaStreamAudioDestinationNode is a sink: it has no outputs to tee onward)
          this.__tap = tap;
          startRecorder(tap.stream);
          if (this.state === 'suspended') this.resume().catch(() => {});
          this.addEventListener('statechange', () => log('ctx state', this.state));
          log('destination tapped, sampleRate', this.sampleRate, 'state', this.state);
        }
        return this.__tap;
      }
    }
    window.AudioContext = TappedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = TappedAudioContext;

    if (cfg.throttleRaf) {
      const period = 1000 / cfg.rafFps;
      const realRaf = window.requestAnimationFrame.bind(window);
      let last = 0;
      window.requestAnimationFrame = (fn) => realRaf((t) => {
        if (t - last >= period) { last = t; fn(t); }
        else setTimeout(() => window.requestAnimationFrame(fn), period - (t - last));
      });
    }

    // Report the page's own status text so Node can log stream state.
    window.addEventListener('DOMContentLoaded', () => {
      const st = document.getElementById('status');
      if (!st) return;
      let prev = '';
      new MutationObserver(() => {
        const t = st.textContent.trim();
        if (t && t !== prev) { prev = t; log('status:', t); }
      }).observe(st, { childList: true, characterData: true, subtree: true });
    });
  })();`;
}
