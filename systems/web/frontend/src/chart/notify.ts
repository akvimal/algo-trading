// How the page tells the person that an alert fired: a short tone and, where they have allowed it, a
// desktop notification. Every step is optional and never throws: a browser with no audio or no
// notifications still gets the message on the page itself.

let audio: AudioContext | null = null;

/** Called when the person arms an alert (a click, so the browser allows it): wakes the audio and asks
 * once for permission to show notifications. */
export function prepareAlertChannel(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) {
      audio ??= new Ctor();
      void audio.resume();
    }
  } catch {
    // no audio here
  }
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // no notifications here
  }
}

function tone(): void {
  try {
    if (!audio) return;
    const now = audio.currentTime;
    for (const [i, hz] of [880, 1175].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, now + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.14);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + i * 0.16);
      osc.stop(now + i * 0.16 + 0.16);
    }
  } catch {
    // no audio here
  }
}

/** Sound the tone and, if allowed, show a desktop notification with the message. */
export function announceAlert(message: string): void {
  tone();
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification("Price alert", { body: message, tag: `price-alert-${message}` });
      n.onclick = () => window.focus();
    }
  } catch {
    // no notifications here
  }
}
