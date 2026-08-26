import { useEffect, useRef, useState } from "react";

import { fetchRecentSignals, fetchStrategies, type ProviderSignal } from "./api";

const POLL_MS = 5000;
const ENABLED_KEY = "signalNotificationsEnabled";
const SOUND_KEY = "signalNotificationSoundEnabled";

// Two quick ascending tones - synthesized directly (Web Audio oscillator),
// not a bundled audio asset, so there's nothing extra to serve/CORS.
function playAlertSound(ctx: AudioContext) {
  const now = ctx.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = now + i * 0.15;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.14);
  });
}

// Fires a browser Notification (+ optional sound) for every NEW signal
// across ALL strategies - polls signal-processing's global GET /signals
// (no strategy_id filter) rather than piggybacking on StrategyManager's
// own per-strategy signal fetch, since the whole point is surfacing a
// signal on a strategy you AREN'T currently looking at. Mounted once at
// the App root (see App.tsx's <header>) so it keeps polling regardless of
// which tab is active.
//
// Notification permission requires a real user gesture in every major
// browser - the toggle button below IS that gesture, and is also where
// the AudioContext gets created (autoplay policies otherwise block audio
// started from a plain setInterval callback with no gesture behind it).
// Requires a secure context (HTTPS, or localhost's explicit exception) -
// the toggle silently no-ops (renders nothing) if window.Notification
// isn't available at all, e.g. a non-secure non-localhost origin.
export function SignalNotifier() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [enabled, setEnabled] = useState(
    () => supported && localStorage.getItem(ENABLED_KEY) === "true" && Notification.permission === "granted"
  );
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem(SOUND_KEY) !== "false");
  // Set only when a permission request comes back (or already was)
  // 'denied' - that's the one outcome the toggle used to swallow
  // silently (button just sat there looking like it did nothing), since
  // a browser that has already denied a site never re-prompts - only the
  // user, via their own browser's site settings, can undo it.
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  // null = not seeded yet - the first poll after enabling only records
  // what's already there, it never fires N notifications for pre-existing
  // history just because notifications were switched on.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const strategyNamesRef = useRef<Map<string, string>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Strategy names, purely cosmetic (the notification body reads better
  // as "Bullish Breakout v1" than a bare UUID) - an independent poll since
  // this component lives above StrategyManager, no state to share with it.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    async function poll() {
      try {
        const data = await fetchStrategies();
        if (!cancelled) strategyNamesRef.current = new Map(data.map((s) => [s.id, s.name]));
      } catch {
        // keep the last known names rather than clearing on a blip
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS * 4); // names change rarely - a slower cadence is enough
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    function notify(s: ProviderSignal) {
      const strategyName = strategyNamesRef.current.get(s.strategy_id) ?? s.strategy_id;
      const n = new Notification(`${s.action} ${s.symbol}`, {
        body: `${strategyName} · ${s.exchange} @ ${s.price}${s.status ? ` · ${s.status}` : ""}`,
        tag: s.signal_id,
      });
      n.onclick = () => window.focus();
      if (soundEnabledRef.current) {
        try {
          if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
          playAlertSound(audioCtxRef.current);
        } catch {
          // audio blocked/unsupported - the visual notification still fired
        }
      }
    }

    async function poll() {
      try {
        const signals = await fetchRecentSignals(20);
        if (cancelled) return;
        if (seenIdsRef.current === null) {
          seenIdsRef.current = new Set(signals.map((s) => s.signal_id));
          return;
        }
        const fresh = signals.filter((s) => !seenIdsRef.current!.has(s.signal_id));
        // Oldest fresh signal first, so notifications appear in the order
        // they actually happened rather than reverse-chronological.
        for (const s of [...fresh].reverse()) {
          seenIdsRef.current.add(s.signal_id);
          notify(s);
        }
      } catch {
        // stay quiet until the next tick rather than notifying about a poll failure
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  if (!supported) return null;

  async function handleToggle() {
    if (enabled) {
      localStorage.setItem(ENABLED_KEY, "false");
      setEnabled(false);
      seenIdsRef.current = null;
      return;
    }
    setBlockedMessage(null);
    // Already denied - calling requestPermission() again would just
    // silently resolve back to 'denied' with no browser prompt at all
    // (every major browser refuses to re-prompt once a site's been
    // denied), which is exactly what made this button look broken.
    // Short-circuit with an actionable message instead of repeating that.
    if (Notification.permission === "denied") {
      setBlockedMessage("Notifications are blocked for this site - allow them in your browser's site settings, then try again.");
      return;
    }
    // Everything below runs synchronously off this click (a real user
    // gesture) up to the await - required both for
    // Notification.requestPermission and to unlock the AudioContext for
    // sounds the poll loop plays later with no gesture of its own.
    if (!audioCtxRef.current) {
      try {
        audioCtxRef.current = new AudioContext();
      } catch {
        // sound just won't play - notifications still work without it
      }
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      localStorage.setItem(ENABLED_KEY, "true");
      setEnabled(true);
    } else if (permission === "denied") {
      setBlockedMessage("Notifications are blocked for this site - allow them in your browser's site settings, then try again.");
    }
    // permission === "default" - the prompt was dismissed without a
    // choice (e.g. clicked away) - stay quiet, clicking the button again
    // just re-prompts, no different from the first click.
  }

  function handleSoundToggle(checked: boolean) {
    setSoundEnabled(checked);
    localStorage.setItem(SOUND_KEY, String(checked));
  }

  return (
    <div className="signal-notifier">
      <button type="button" className={enabled ? "tiny" : "tiny secondary"} onClick={handleToggle}>
        {enabled ? "🔔 Notifications on" : "🔕 Enable notifications"}
      </button>
      {enabled && (
        <label className="checkbox-label tiny-checkbox">
          <input type="checkbox" checked={soundEnabled} onChange={(e) => handleSoundToggle(e.target.checked)} />
          Sound
        </label>
      )}
      {blockedMessage && <span className="signal-notifier-blocked">{blockedMessage}</span>}
    </div>
  );
}
