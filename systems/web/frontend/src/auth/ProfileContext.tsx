import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getProfile, updatePreferences } from "../api/profile";
import type { Profile, Segment } from "../api/types";

type Status = "loading" | "ready" | "error";

type ProfileValue = {
  profile: Profile | null;
  status: Status;
  /** True unless the person chose Pro. The default (and the fallback when the profile cannot be
   * read) is the gentler view. */
  guided: boolean;
  /** The markets they practise on: all three when the profile cannot be read. */
  markets: Segment[];
  /** What a fresh trade ticket should pre-select - "future" (the ticket's own longstanding
   * default) when the profile cannot be read. */
  defaultInstrument: "future" | "option";
  defaultOptionStrategy: "naked" | "spread";
  /** What a fresh ticket starts on in this market: its own choice if there is one, else the general default above. */
  defaultsFor: (segment: Segment) => { instrument: "future" | "option"; optionStrategy: "naked" | "spread" };
  update: (prefs: {
    experience?: "guided" | "pro";
    onboarded?: boolean;
    markets?: Segment[];
    default_instrument?: "future" | "option";
    default_option_strategy?: "naked" | "spread";
    segment_defaults?: Profile["segment_defaults"];
  }) => Promise<Profile>;
  reload: () => void;
};

const ProfileContext = createContext<ProfileValue | null>(null);

/** Who the signed-in person is beyond their token: their chosen experience and whether they have
 * been through first-run setup. Mounted only while signed in, so a new session always re-reads it. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus("loading");
    getProfile()
      .then((p) => {
        if (!live) return;
        setProfile(p);
        setStatus("ready");
      })
      .catch(() => {
        if (live) setStatus("error");
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const update = useCallback(
    async (prefs: {
      experience?: "guided" | "pro";
      onboarded?: boolean;
      markets?: Segment[];
      default_instrument?: "future" | "option";
      default_option_strategy?: "naked" | "spread";
      segment_defaults?: Profile["segment_defaults"];
    }) => {
      const next = await updatePreferences(prefs);
      setProfile(next);
      setStatus("ready");
      return next;
    },
    [],
  );

  const value = useMemo<ProfileValue>(
    () => ({
      profile,
      status,
      guided: profile?.experience !== "pro",
      markets: profile?.markets?.length ? profile.markets : ["NSE", "MCX", "CRYPTO"],
      defaultInstrument: profile?.default_instrument ?? "future",
      defaultOptionStrategy: profile?.default_option_strategy ?? "naked",
      defaultsFor: (segment: Segment) => {
        const own = profile?.segment_defaults?.[segment];
        return own
          ? { instrument: own.instrument, optionStrategy: own.option_strategy }
          : { instrument: profile?.default_instrument ?? "future", optionStrategy: profile?.default_option_strategy ?? "naked" };
      },
      update,
      reload: () => setTick((n) => n + 1),
    }),
    [profile, status, update],
  );
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used inside <ProfileProvider>");
  return ctx;
}
