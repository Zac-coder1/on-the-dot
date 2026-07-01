import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { loadLocal, saveLocal, loadRemote, saveRemote, mergeStats } from "./storage";

// ---------- deterministic daily RNG so everyone gets the same targets ----------
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const localKey = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const todayKey = () => localKey(new Date());
const yesterdayKey = () => localKey(new Date(Date.now() - 864e5));

// Streak still counts only if the last play was today or yesterday (local); otherwise it's broken.
function effectiveStreak(save) {
  if (!save || !save.streak) return 0;
  const last = save.lastDate;
  return last === todayKey() || last === yesterdayKey() ? save.streak : 0;
}

function makeTargets(seedStr) {
  const rng = hashStr(seedStr);
  // Seeded by the date so everyone gets the same set each day.
  // Round 1 is always < 5s (quick start for new players), and at most 2 of the
  // remaining rounds may exceed 5s so a session never drags.
  const LONG_CUT = 5;
  const MAX_LONG = 2;
  let longCount = 0;
  return Array.from({ length: ROUNDS }, (_, i) => {
    let v;
    if (i === 0) {
      v = T_MIN + rng() * (LONG_CUT - T_MIN); // first round: quick, always under 5s
    } else {
      v = T_MIN + rng() * (T_MAX - T_MIN);
      if (v > LONG_CUT) {
        if (longCount < MAX_LONG) longCount++;
        else v = T_MIN + rng() * (LONG_CUT - T_MIN); // too many long rounds already
      }
    }
    return Math.round(v * 100) / 100;
  });
}

const WINDOW = 1.0; // seconds; error beyond this scores 0
const ROUNDS = 5;
const ON_THE_DOT = 0.005; // must round to 0.00 — i.e. land exactly on the target
const T_MIN = 0.1, T_MAX = 10; // hard bounds for any generated target
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randPracticeTarget = () =>
  Math.round(clamp(0.5 + Math.random() * 9.5, T_MIN, T_MAX) * 100) / 100;

// ---------- scoring + share bands ----------
function accuracy(error) {
  return Math.max(0, 1 - error / WINDOW); // 0..1
}
function band(error) {
  // error is the absolute miss, so this applies equally whether you were early or late
  if (error < ON_THE_DOT) return { sq: "🎯", label: "On the dot", color: C.bandGreen }; // exact only
  if (error < 0.06) return { sq: "🟪", label: "So close", color: C.bandPurple }; // 0.01–0.05
  if (error < 0.15) return { sq: "🟨", label: "Close", color: C.bandYellow };
  if (error < 0.3) return { sq: "🟧", label: "Off", color: C.bandOrange };
  return { sq: "⬛", label: "Way off", color: C.bandDim };
}


// Haptic feedback. Fires on Android/Chrome + supported browsers.
// iOS Safari ignores the Vibration API — needs a native/PWA wrapper for real Taptic.
function haptic(pattern = 14) {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
  } catch {}
}

const C = {
  bg: "#0C0F17",
  surface: "#141925",
  surface2: "#1B2230",
  line: "#262E3D",
  text: "#ECEEF3",
  muted: "#8A93A6",
  live: "#FF5436",
  cool: "#38E2C6",
  amber: "#FFC24B",
  // result bands (Today's run / share grid / reveal)
  bandGreen: "#3DD68C",
  bandPurple: "#A98BFF",
  bandYellow: "#FFD43B",
  bandOrange: "#FF8A3D",
  bandDim: "#5A6275",
};

const mono = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const fmt = (n) => n.toFixed(2);

export default function OnTheDot() {
  const targetsRef = useRef(makeTargets(todayKey()));
  const targets = targetsRef.current;

  const [phase, setPhase] = useState("home"); // home | ready | running | reveal | summary
  const [round, setRound] = useState(0);
  const [results, setResults] = useState([]); // {target, stop, error}
  const [practice, setPractice] = useState(false);
  const [save, setSave] = useState(null);
  const [playedToday, setPlayedToday] = useState(false);
  const [user, setUser] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [accuracyOpen, setAccuracyOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const startRef = useRef(0);

  useEffect(() => {
    // Show whatever is saved on this device right away, so the UI isn't empty.
    const local = loadLocal();
    setSave(local);
    if (local && local.lastDate === todayKey()) setPlayedToday(true);
  }, []);

  // Supabase auth session + cross-device stats sync
  useEffect(() => {
    let active = true;

    const syncForUser = async (sessionUser) => {
      if (!active) return;
      setUser(sessionUser);
      if (!sessionUser) return;
      // Merge this device's progress with the account's progress, keep the best of each.
      const local = loadLocal();
      const remote = await loadRemote(sessionUser.id);
      const merged = mergeStats(local, remote);
      if (!active || !merged) return;
      setSave(merged);
      setPlayedToday(merged.lastDate === todayKey());
      saveLocal(merged);
      await saveRemote(sessionUser.id, merged);
    };

    supabase.auth.getSession().then(({ data }) => {
      syncForUser(data?.session?.user ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecoveryOpen(true);
      syncForUser(session?.user ?? null);
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  const handleAuth = async (mode, email, password) => {
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      // If email confirmation is ON in Supabase, there's no session yet.
      if (!data.session) {
        throw new Error("Account created — check your email to confirm, then sign in.");
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
    setAuthOpen(false); // onAuthStateChange handles loading stats
  };

  const handleOAuth = async (provider) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider, // "google" | "apple"
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
    // The browser now redirects to Google/Apple; nothing else to do here.
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const handleReset = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
  };

  const handleNewPassword = async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    setRecoveryOpen(false);
  };

  const currentTarget = practice
    ? targetsRef.current._practice ?? targets[round % ROUNDS]
    : targets[round];

  // ----- game actions -----
  const begin = (isPractice) => {
    setPractice(!!isPractice);
    setResults([]);
    setRound(0);
    setPhase("ready");
  };

  const goHome = () => {
    setPractice(false);
    setRound(0);
    setResults([]);
    setPhase("home");
  };

  // Re-open today's finished run so the player can review it from the home screen.
  const reviewToday = () => {
    if (save?.lastRun?.date === todayKey() && save.lastRun.results?.length) {
      setPractice(false);
      setResults(save.lastRun.results);
      setPhase("summary");
    }
  };

  const arm = () => {
    haptic(18);
    startRef.current = performance.now();
    setPhase("running");
  };

  const stop = () => {
    haptic([0, 22, 18, 22]);
    const elapsed = (performance.now() - startRef.current) / 1000;
    const target = currentTarget;
    const error = Math.abs(elapsed - target);
    setResults((r) => [...r, { target, stop: elapsed, error }]);
    setPhase("reveal");
  };

  const next = () => {
    if (practice) {
      targetsRef.current._practice = randPracticeTarget(); // endless fresh targets
      setRound((r) => r + 1);
      setPhase("ready");
      return;
    }
    if (round + 1 >= ROUNDS) finishDaily();
    else {
      setRound((r) => r + 1);
      setPhase("ready");
    }
  };

  const finishDaily = useCallback(() => {
    setPhase("summary");
    const all = results;
    const avgErr = all.reduce((a, b) => a + b.error, 0) / all.length;
    const acc = Math.round(
      (all.reduce((a, b) => a + accuracy(b.error), 0) / all.length) * 100
    );
    const dotsThisRun = all.filter((r) => r.error < ON_THE_DOT).length;
    const bestSingleRun = Math.min(...all.map((r) => r.error));
    const td = todayKey();
    const prev = save;
    const yesterday = yesterdayKey();
    let streak = 1;
    if (prev) {
      if (prev.lastDate === td) streak = prev.streak; // already counted today
      else if (prev.lastDate === yesterday) streak = prev.streak + 1;
    }
    const counted = prev?.lastDate === td; // avoid double-counting a same-day replay
    const history = [...(prev?.history ?? [])];
    if (!counted) history.push({ date: td, avgErr, acc });
    const next = {
      lastDate: td,
      streak,
      longestStreak: Math.max(prev?.longestStreak ?? 0, streak),
      best: prev ? Math.min(prev.best ?? Infinity, avgErr) : avgErr,
      bestSingle: prev ? Math.min(prev.bestSingle ?? Infinity, bestSingleRun) : bestSingleRun,
      onTheDot: (prev?.onTheDot ?? 0) + (counted ? 0 : dotsThisRun),
      plays: (prev?.plays ?? 0) + (counted ? 0 : 1),
      totalRounds: (prev?.totalRounds ?? 0) + (counted ? 0 : all.length),
      history: history.slice(-400),
      lastRun: {
        date: td,
        results: all.map((r) => ({ target: r.target, stop: r.stop, error: r.error })),
      },
    };
    setSave(next);
    setPlayedToday(true);
    saveLocal(next); // always save on this device
    if (user) saveRemote(user.id, next); // and to the account, if signed in
  }, [results, save, user]);

  // spacebar = universal trigger (feels like a real stopwatch)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      if (phase === "ready") arm();
      else if (phase === "running") stop();
      else if (phase === "reveal") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- derived summary stats -----
  const avgErr = results.length
    ? results.reduce((a, b) => a + b.error, 0) / results.length
    : 0;
  const avgAcc = results.length
    ? Math.round((results.reduce((a, b) => a + accuracy(b.error), 0) / results.length) * 100)
    : 0;
  const bias = results.length
    ? results.reduce((a, b) => a + (b.stop - b.target), 0) / results.length
    : 0;

  const shareText = () => {
    const grid = results.map((r) => band(r.error).sq).join("");
    const link = typeof window !== "undefined" ? window.location.origin : "";
    return `ON-THE-DOT — ${todayKey()}\n${grid}\nAvg miss ${fmt(avgErr)}s · ${avgAcc}% accuracy\nStreak 🔥${save?.streak ?? 1}\n${link}`;
  };

  return (
    <div style={S.root}>
      <style>{css}</style>
      <div style={S.frame}>
        <Header
          save={save}
          practice={practice}
          onBack={phase !== "home" && phase !== "running" ? goHome : null}
          user={user}
          onSignInClick={() => setAuthOpen(true)}
          onSignOut={signOut}
          onViewStats={() => setStatsOpen(true)}
          onViewAccuracy={() => setAccuracyOpen(true)}
        />

        {phase === "home" && (
          <Home
            targets={targets}
            playedToday={playedToday}
            save={save}
            onPlay={() => begin(false)}
            onReview={reviewToday}
            onPractice={() => {
              targetsRef.current._practice = randPracticeTarget();
              begin(true);
            }}
          />
        )}

        {phase === "ready" && (
          <Ready
            round={round}
            practice={practice}
            target={currentTarget}
            onArm={arm}
          />
        )}

        {phase === "running" && <Running onStop={stop} />}

        {phase === "reveal" && (
          <Reveal
            r={results[results.length - 1]}
            round={round}
            practice={practice}
            onNext={next}
            isLast={!practice && round + 1 >= ROUNDS}
          />
        )}

        {phase === "summary" && (
          <Summary
            results={results}
            avgErr={avgErr}
            avgAcc={avgAcc}
            bias={bias}
            streak={save?.streak ?? 1}
            best={save?.best}
            save={save}
            shareText={shareText()}
            onPractice={() => {
              targetsRef.current._practice = randPracticeTarget();
              begin(true);
            }}
          />
        )}

        {authOpen && (
          <AuthModal
            onClose={() => setAuthOpen(false)}
            onAuth={handleAuth}
            onOAuth={handleOAuth}
            onReset={handleReset}
          />
        )}
        {statsOpen && <StatsModal save={save} onClose={() => setStatsOpen(false)} />}
        {accuracyOpen && (
          <AccuracyModal save={save} onClose={() => setAccuracyOpen(false)} />
        )}
        {recoveryOpen && (
          <RecoveryModal
            onSubmit={handleNewPassword}
            onClose={() => setRecoveryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- components ----------------
function Header({ save, onBack, practice, user, onSignInClick, onSignOut, onViewStats, onViewAccuracy }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div style={S.header}>
      {onBack ? (
        <button style={S.backBtn} onClick={onBack} aria-label="Back to daily challenge">
          ‹ {practice ? "Daily" : "Home"}
        </button>
      ) : (
        <div style={S.brand}>
          ON-THE-<span style={{ color: C.live }}>DOT</span>
        </div>
      )}

      <div style={S.headerRight}>
        <div style={S.streak}>
          🔥 <span style={{ fontFamily: mono }}>{effectiveStreak(save)}</span>
        </div>
        {user ? (
          <div style={S.avatarWrap}>
            <button
              style={S.avatar}
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Account menu"
            >
              {((user.email || "?")[0]).toUpperCase()}
            </button>
            {menuOpen && (
              <>
                <div style={S.menuBackdrop} onClick={() => setMenuOpen(false)} />
                <div style={S.menu}>
                  <div style={S.menuEmail}>{user.email}</div>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onViewStats();
                    }}
                  >
                    View statistics
                  </button>
                  <button
                    style={S.menuItem}
                    onClick={() => {
                      setMenuOpen(false);
                      onViewAccuracy();
                    }}
                  >
                    Accuracy
                  </button>
                  <button
                    style={{ ...S.menuItem, color: C.live }}
                    onClick={() => {
                      setMenuOpen(false);
                      onSignOut();
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button style={S.signInBtn} onClick={onSignInClick}>
            Sign in
          </button>
        )}
      </div>
    </div>
  );
}

function Overlay({ children, onClose }) {
  return (
    <div style={S.overlay}>
      <div style={S.overlayBackdrop} onClick={onClose} />
      <div style={S.modal}>
        <button style={S.modalClose} onClick={onClose} aria-label="Close">
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function AuthModal({ onClose, onAuth, onReset }) {
  const [mode, setMode] = useState("signin"); // signin | signup | reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const validEmail = (em) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em);
  const switchMode = (m) => {
    setMode(m);
    setError("");
    setSent(false);
  };

  const submit = async () => {
    const em = email.trim();
    if (!validEmail(em)) return setError("Enter a valid email address.");
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    setError("");
    setBusy(true);
    try {
      await onAuth(mode, em, password);
    } catch (e) {
      setError(e?.message || "Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  const sendReset = async () => {
    const em = email.trim();
    if (!validEmail(em)) return setError("Enter a valid email address.");
    setError("");
    setBusy(true);
    try {
      await onReset(em);
      setSent(true);
    } catch (e) {
      setError(e?.message || "Couldn’t send the reset email. Try again.");
    }
    setBusy(false);
  };

  const onKey = (e) => {
    if (e.key !== "Enter") return;
    mode === "reset" ? sendReset() : submit();
  };

  // ----- forgot-password view -----
  if (mode === "reset") {
    return (
      <Overlay onClose={onClose}>
        <div style={S.modalTitle}>Reset password</div>
        {sent ? (
          <>
            <div style={S.modalSub}>
              If an account exists for {email.trim()}, a reset link is on its way. Check your
              inbox (and spam), open the link, and you’ll set a new password.
            </div>
            <button style={{ ...S.btnPrimary, marginTop: 6 }} onClick={() => switchMode("signin")}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <div style={S.modalSub}>
              Enter your email and we’ll send you a link to reset your password.
            </div>
            <input
              style={S.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onKey}
              autoFocus
            />
            {error && <div style={S.formErr}>{error}</div>}
            <button
              style={{ ...S.btnPrimary, marginTop: 14, opacity: busy ? 0.6 : 1 }}
              disabled={busy}
              onClick={sendReset}
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
            <button style={S.linkBtn} onClick={() => switchMode("signin")}>
              Back to sign in
            </button>
          </>
        )}
      </Overlay>
    );
  }

  // ----- sign in / sign up view -----
  return (
    <Overlay onClose={onClose}>
      <div style={S.modalTitle}>{mode === "signin" ? "Welcome back" : "Create account"}</div>
      <div style={S.modalSub}>Save your stats and track them across all your devices.</div>

      <input
        style={S.input}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={onKey}
        autoFocus
      />
      <input
        style={S.input}
        type="password"
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={onKey}
      />
      {error && <div style={S.formErr}>{error}</div>}
      <button
        style={{ ...S.btnPrimary, marginTop: 14, opacity: busy ? 0.6 : 1 }}
        disabled={busy}
        onClick={submit}
      >
        {busy ? "One sec…" : mode === "signin" ? "Sign in" : "Create account"}
      </button>

      {mode === "signin" && (
        <button style={S.linkBtn} onClick={() => switchMode("reset")}>
          Forgot password?
        </button>
      )}
      <button
        style={{ ...S.linkBtn, marginTop: mode === "signin" ? 6 : 14 }}
        onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
      >
        {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
    </Overlay>
  );
}

function RecoveryModal({ onSubmit, onClose }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (password.length < 6) return setError("Password must be at least 6 characters.");
    if (password !== confirm) return setError("Passwords don’t match.");
    setError("");
    setBusy(true);
    try {
      await onSubmit(password);
      setDone(true);
    } catch (e) {
      setError(e?.message || "Couldn’t update your password. Try again.");
      setBusy(false);
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <Overlay onClose={onClose}>
      <div style={S.modalTitle}>Set a new password</div>
      {done ? (
        <>
          <div style={S.modalSub}>Your password is updated and you’re signed in. All set!</div>
          <button style={{ ...S.btnPrimary, marginTop: 6 }} onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <>
          <div style={S.modalSub}>Choose a new password for your account.</div>
          <input
            style={S.input}
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onKey}
            autoFocus
          />
          <input
            style={S.input}
            type="password"
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={onKey}
          />
          {error && <div style={S.formErr}>{error}</div>}
          <button
            style={{ ...S.btnPrimary, marginTop: 14, opacity: busy ? 0.6 : 1 }}
            disabled={busy}
            onClick={submit}
          >
            {busy ? "Saving…" : "Update password"}
          </button>
        </>
      )}
    </Overlay>
  );
}

// Average accuracy over the last `days` calendar days, counting ONLY days actually played.
// Days with no play simply aren't in history, so they're skipped (never counted as 0%).
function periodAvg(history, days) {
  if (!history || !history.length) return null;
  const cutoff = localKey(new Date(Date.now() - (days - 1) * 864e5));
  const inWin = history.filter((h) => h && h.date >= cutoff && typeof h.acc === "number");
  if (!inWin.length) return null;
  return Math.round(inWin.reduce((a, b) => a + b.acc, 0) / inWin.length);
}

function StatsModal({ save, onClose }) {
  const s = save || {};
  const history = s.history || [];
  const finiteOr = (v, suffix = "s") => (v != null && isFinite(v) ? `${fmt(v)}${suffix}` : "—");
  const overallMiss = history.length
    ? history.reduce((a, b) => a + (typeof b.avgErr === "number" ? b.avgErr : 0), 0) /
      history.length
    : null;

  return (
    <Overlay onClose={onClose}>
      <div style={S.modalTitle}>Your statistics</div>
      <div style={S.statsGrid}>
        <MiniStat label="On the dot" value={`🎯 ${s.onTheDot ?? 0}`} hero />
        <MiniStat label="Current streak" value={`🔥 ${effectiveStreak(save)}`} />
        <MiniStat label="Best streak" value={`🔥 ${s.longestStreak ?? 0}`} />
        <MiniStat label="Closest ever" value={finiteOr(s.bestSingle)} />
        <MiniStat label="Avg miss" value={overallMiss != null ? `${fmt(overallMiss)}s` : "—"} />
        <MiniStat label="Games played" value={`${s.plays ?? 0}`} />
      </div>
      {history.length > 1 ? (
        <div style={S.sparkWrap}>
          <TrendChart data={history} mode="miss" />
          <div style={S.sparkCaption}>avg miss over the days you played · higher line = better</div>
        </div>
      ) : (
        <div style={{ ...S.modalSub, marginTop: 16 }}>
          Play a daily run to start building your history.
        </div>
      )}
    </Overlay>
  );
}

function AccuracyModal({ save, onClose }) {
  const s = save || {};
  const history = s.history || [];
  const pct = (v) => (v == null ? "—" : `${v}%`);
  const overallAcc = history.length
    ? Math.round(
        history.reduce((a, b) => a + (typeof b.acc === "number" ? b.acc : 0), 0) / history.length
      )
    : null;

  return (
    <Overlay onClose={onClose}>
      <div style={S.modalTitle}>Accuracy</div>
      <div style={S.statsGrid}>
        <MiniStat label="Today" value={pct(periodAvg(history, 1))} hero />
        <MiniStat label="This week" value={pct(periodAvg(history, 7))} />
        <MiniStat label="This month" value={pct(periodAvg(history, 30))} />
        <MiniStat label="Overall" value={pct(overallAcc)} />
      </div>
      {history.length > 1 ? (
        <div style={S.sparkWrap}>
          <TrendChart data={history} mode="accuracy" />
          <div style={S.sparkCaption}>accuracy over the days you played · higher is better</div>
        </div>
      ) : (
        <div style={{ ...S.modalSub, marginTop: 16 }}>
          Play a few days to see your accuracy trend. Days you don’t play aren’t counted.
        </div>
      )}
    </Overlay>
  );
}

function TrendChart({ data, mode }) {
  const n = data.length;
  const W = 300,
    H = 100,
    padL = 40,
    padR = 8,
    padT = 10,
    padB = 20;
  const plotW = W - padL - padR,
    plotH = H - padT - padB;

  let vals, frac, topLabel, midLabel, bottomLabel;
  if (mode === "accuracy") {
    vals = data.map((d) => (typeof d.acc === "number" ? d.acc : 0));
    frac = (v) => v / 100; // 100% at top
    topLabel = "100%";
    midLabel = "50%";
    bottomLabel = "0%";
  } else {
    vals = data.map((d) => (typeof d.avgErr === "number" ? d.avgErr : 0));
    const maxMiss = Math.max(0.1, ...vals);
    frac = (v) => 1 - v / maxMiss; // 0s (perfect) at top
    topLabel = "0s";
    midLabel = `${fmt(maxMiss / 2)}s`;
    bottomLabel = `${fmt(maxMiss)}s`;
  }
  const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (f) => padT + (1 - f) * plotH;
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(frac(v)).toFixed(1)}`).join(" ");
  const grid = [
    { g: 1, label: topLabel },
    { g: 0.5, label: midLabel },
    { g: 0, label: bottomLabel },
  ];
  const lastF = frac(vals[n - 1]);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {grid.map(({ g, label }) => (
        <g key={g}>
          <line
            x1={padL}
            y1={y(g)}
            x2={W - padR}
            y2={y(g)}
            stroke={C.line}
            strokeWidth="1"
            strokeDasharray={g === 0.5 ? "3 4" : ""}
            opacity={g === 0.5 ? 0.9 : 0.5}
          />
          <text
            x={padL - 7}
            y={y(g) + 3}
            textAnchor="end"
            fontSize="9"
            fill={C.muted}
            fontFamily={mono}
          >
            {label}
          </text>
        </g>
      ))}
      <polyline
        points={pts}
        fill="none"
        stroke={C.cool}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(n - 1)} cy={y(lastF)} r="3.5" fill={C.cool} />
      <text x={padL} y={H - 5} textAnchor="start" fontSize="9" fill={C.muted}>
        older
      </text>
      <text x={W - padR} y={H - 5} textAnchor="end" fontSize="9" fill={C.muted}>
        today
      </text>
    </svg>
  );
}

function Home({ targets, playedToday, save, onPlay, onReview, onPractice }) {
  const canReview = save?.lastRun?.date === todayKey() && save.lastRun.results?.length;
  return (
    <div style={S.pane}>
      <div style={S.tagline}>Stop the clock blind. As close to the target as you can.</div>
      <div style={S.bigNum}>{fmt(targets[0])}<span style={S.unit}>s</span></div>
      <div style={S.sub}>Today’s first target · 5 rounds · no clock while it runs</div>

      {playedToday ? (
        <>
          <div style={S.donePill}>Daily done — back tomorrow</div>
          {canReview && (
            <button style={S.btnPrimary} onClick={onReview}>View today’s run</button>
          )}
          <button style={S.btnGhost} onClick={onPractice}>Practice (unlimited)</button>
        </>
      ) : (
        <>
          <button style={S.btnPrimary} onClick={onPlay}>Play today</button>
          <button style={S.btnGhost} onClick={onPractice}>Practice first</button>
        </>
      )}
      <div style={S.hint}>Tip: tap, or press <kbd style={S.kbd}>Space</kbd> to start &amp; stop.</div>

      {save && (save.plays ?? 0) > 0 && (
        <div style={S.homeStats}>
          <span>🎯 <b style={{ color: C.cool }}>{save.onTheDot ?? 0}</b> on the dot</span>
          <span style={S.homeStatDiv}>·</span>
          <span>🔥 <b>{save.longestStreak ?? save.streak ?? 0}</b> best</span>
          <span style={S.homeStatDiv}>·</span>
          <span><b>{save.bestSingle != null ? fmt(save.bestSingle) + "s" : "—"}</b> closest</span>
        </div>
      )}
    </div>
  );
}

function Ready({ round, practice, target, onArm }) {
  const [demo, setDemo] = useState(null); // null = idle; otherwise live demo value
  const rafRef = useRef(0);
  const toRef = useRef(0);

  const runDemo = () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(toRef.current);
    const DUR = 4; // neutral demo length — deliberately not the target
    const t0 = performance.now();
    setDemo(0);
    const tick = (now) => {
      const v = (now - t0) / 1000;
      if (v >= DUR) {
        setDemo(DUR);
        toRef.current = setTimeout(() => setDemo(null), 1000); // settle back to target
        return;
      }
      setDemo(v);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(toRef.current);
  }, []);

  const showing = demo !== null;
  return (
    <div style={S.pane}>
      <div style={S.roundLabel}>{practice ? "Practice" : `Round ${round + 1} / ${ROUNDS}`}</div>
      <div style={{ ...S.aimLabel, color: showing ? C.cool : C.muted }}>
        {showing ? "demo speed · not the target" : "Stop at"}
      </div>
      <div style={{ ...S.bigNum, color: showing ? C.cool : C.text }}>
        {fmt(showing ? demo : target)}
        <span style={S.unit}>s</span>
      </div>
      <button style={S.btnDemo} onPointerDown={runDemo}>
        {showing ? "Replay clock speed" : "Preview clock speed"}
      </button>
      <button style={S.btnPrimary} onPointerDown={onArm}>Start</button>
      <div style={S.hint}>The screen goes dark and the clock runs hidden. Stop when it feels right.</div>
    </div>
  );
}

function Running({ onStop }) {
  return (
    <button className="otd-enter" style={S.void} onPointerDown={onStop} aria-label="Stop the clock">
      <span style={S.livePill}>
        <span className="otd-pulse" style={S.liveDot} />
        TIMING
      </span>
      <span style={S.voidBig}>clock is running</span>
      <span style={S.voidText}>tap anywhere to stop</span>
    </button>
  );
}

function Reveal({ r, onNext, isLast }) {
  const b = band(r.error);
  const lo = Math.min(r.target, r.stop);
  const hi = Math.max(r.target, r.stop);
  const span = Math.max(hi - lo, 0.001);
  const pad = Math.max(span * 0.6, 0.4);
  const axisLo = lo - pad;
  const axisHi = hi + pad;
  const pos = (v) => ((v - axisLo) / (axisHi - axisLo)) * 100;
  const early = r.stop < r.target;

  return (
    <div style={S.pane}>
      <div style={{ ...S.verdict, color: b.color }}>
        {r.error < ON_THE_DOT ? "🎯 ON THE DOT!" : b.label}
      </div>

      {/* photo-finish line */}
      <div style={S.track}>
        <div style={{ ...S.mark, left: `${pos(r.target)}%`, background: C.text }}>
          <div style={{ ...S.markLabel, color: C.muted }}>target {fmt(r.target)}</div>
        </div>
        <div
          className="otd-slide"
          style={{ ...S.mark, left: `${pos(r.stop)}%`, background: b.color }}
        >
          <div style={{ ...S.markLabel, color: b.color, top: 26 }}>
            you {fmt(r.stop)}
          </div>
        </div>
      </div>

      <div style={S.errRow}>
        <span style={{ fontFamily: mono, fontSize: 40, color: b.color }}>
          {early ? "−" : "+"}
          {fmt(r.error)}s
        </span>
        <span style={S.errWord}>{early ? "early" : "late"}</span>
      </div>
      <div style={S.accLine}>{Math.round(accuracy(r.error) * 100)}% accurate</div>

      <button style={S.btnPrimary} onClick={onNext}>
        {isLast ? "See results" : "Next"}
      </button>
    </div>
  );
}

function Summary({ results, avgErr, avgAcc, bias, streak, best, save, shareText, onPractice }) {
  const [copied, setCopied] = useState(false);
  const dotsThisRun = results.filter((r) => r.error < ON_THE_DOT).length;
  const biasPct = Math.max(-1, Math.min(1, bias / 0.5)); // clamp for meter
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div style={S.pane}>
      <div style={S.roundLabel}>Today’s run</div>
      <div style={S.grid}>
        {results.map((r, i) => {
          const b = band(r.error);
          const signed = r.stop - r.target; // + = late, − = early
          const cellText =
            r.error < 0.005 ? fmt(0) : `${signed > 0 ? "+" : "−"}${fmt(Math.abs(signed))}`;
          return (
            <div key={i} style={{ ...S.cell, borderColor: b.color }}>
              <div style={{ fontFamily: mono, color: b.color, fontSize: 16 }}>
                {cellText}
              </div>
              <div style={S.cellSub}>R{i + 1}</div>
            </div>
          );
        })}
      </div>

      {dotsThisRun > 0 && (
        <div style={S.dotCallout}>
          🎯 {dotsThisRun} on the dot {dotsThisRun > 1 ? "hits" : "hit"} this run!
        </div>
      )}

      <div style={S.statRow}>
        <Stat label="Accuracy" value={`${avgAcc}%`} />
        <Stat label="Avg miss" value={`${fmt(avgErr)}s`} />
        <Stat label="Streak" value={`🔥${streak}`} />
      </div>

      {/* bias meter — the retention hook */}
      <div style={S.biasWrap}>
        <div style={S.biasLabelRow}>
          <span>Early</span>
          <span style={{ color: C.muted }}>your timing today</span>
          <span>Late</span>
        </div>
        <div style={S.biasTrack}>
          <div style={S.biasCenter} />
          <div
            style={{
              ...S.biasDot,
              left: `${50 + biasPct * 50}%`,
              background: avgErr < 0.1 ? C.cool : C.amber,
            }}
          />
        </div>
        <div style={S.biasHint}>
          {avgErr < 0.1
            ? "Beautifully calibrated — dialed in today."
            : Math.abs(bias) < 0.08
            ? `All over the place today — early on some, late on others (off by ${fmt(avgErr)}s on average). Aim for consistency.`
            : bias < 0
            ? `You stopped early most of the time (about ${fmt(Math.abs(bias))}s) — wait a beat longer.`
            : `You stopped late most of the time (about ${fmt(bias)}s) — go a touch sooner.`}
        </div>
      </div>

      {/* lifetime tracker — the come-back hook */}
      {save && (
        <div style={S.lifeWrap}>
          <div style={S.lifeRow}>
            <MiniStat label="On the dot" value={`🎯 ${save.onTheDot ?? 0}`} hero />
            <MiniStat label="Best streak" value={`🔥 ${save.longestStreak ?? streak}`} />
            <MiniStat
              label="Closest ever"
              value={save.bestSingle != null ? `${fmt(save.bestSingle)}s` : "—"}
            />
          </div>
          {save.history && save.history.length > 1 && (
            <div style={S.sparkWrap}>
              <TrendChart data={save.history} mode="miss" />
              <div style={S.sparkCaption}>avg miss over the days you played · higher line = better</div>
            </div>
          )}
        </div>
      )}

      <button style={S.btnPrimary} onClick={copy}>
        {copied ? "Copied!" : "Share result"}
      </button>
      <button style={S.btnGhost} onClick={onPractice}>Keep practicing</button>
    </div>
  );
}

function MiniStat({ label, value, hero }) {
  return (
    <div style={S.miniStat}>
      <div style={{ ...S.miniVal, color: hero ? C.cool : C.text }}>{value}</div>
      <div style={S.miniLabel}>{label}</div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={S.stat}>
      <div style={{ fontFamily: mono, fontSize: 22, color: C.text }}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </div>
  );
}

// ---------------- styles ----------------
const S = {
  root: {
    minHeight: "100dvh",
    background: `radial-gradient(120% 80% at 50% -10%, #161D2C 0%, ${C.bg} 60%)`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    color: C.text,
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  frame: {
    position: "relative",
    width: "100%",
    maxWidth: 440,
    background: C.surface,
    border: `1px solid ${C.line}`,
    borderRadius: 22,
    overflow: "hidden",
    boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px",
    borderBottom: `1px solid ${C.line}`,
  },
  brand: { fontWeight: 800, letterSpacing: 1, fontSize: 15 },
  backBtn: {
    background: "transparent",
    border: "none",
    color: C.muted,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: 0.3,
    cursor: "pointer",
    padding: "4px 8px 4px 0",
    marginLeft: -2,
  },
  streak: { color: C.muted, fontSize: 14, fontWeight: 700 },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  signInBtn: {
    background: "transparent",
    color: C.text,
    border: `1px solid ${C.line}`,
    borderRadius: 999,
    padding: "7px 16px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  avatarWrap: { position: "relative" },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "none",
    background: `linear-gradient(135deg, ${C.cool}, #2BAE98)`,
    color: "#06241F",
    fontWeight: 800,
    fontSize: 15,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  menuBackdrop: { position: "fixed", inset: 0, zIndex: 40 },
  menu: {
    position: "absolute",
    top: 44,
    right: 0,
    minWidth: 190,
    background: C.surface2,
    border: `1px solid ${C.line}`,
    borderRadius: 14,
    padding: 6,
    zIndex: 50,
    boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
  },
  menuEmail: {
    color: C.muted,
    fontSize: 12,
    padding: "8px 10px 10px",
    borderBottom: `1px solid ${C.line}`,
    marginBottom: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  menuItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: C.text,
    fontSize: 14,
    fontWeight: 600,
    padding: "10px 10px",
    borderRadius: 8,
    cursor: "pointer",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    zIndex: 60,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  overlayBackdrop: {
    position: "absolute",
    inset: 0,
    background: "rgba(6,9,15,0.78)",
    backdropFilter: "blur(2px)",
  },
  modal: {
    position: "relative",
    width: "100%",
    maxWidth: 360,
    background: C.surface,
    border: `1px solid ${C.line}`,
    borderRadius: 18,
    padding: "26px 22px 22px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
  },
  modalClose: {
    position: "absolute",
    top: 10,
    right: 12,
    background: "transparent",
    border: "none",
    color: C.muted,
    fontSize: 24,
    lineHeight: 1,
    cursor: "pointer",
    padding: 4,
  },
  modalTitle: { fontSize: 21, fontWeight: 800, marginBottom: 6 },
  modalSub: { color: C.muted, fontSize: 13, lineHeight: 1.45, marginBottom: 18, maxWidth: 280 },
  input: {
    width: "100%",
    background: C.bg,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "13px 14px",
    fontSize: 15,
    color: C.text,
    marginBottom: 10,
    outline: "none",
    boxSizing: "border-box",
  },
  formErr: { color: C.live, fontSize: 13, fontWeight: 600, marginBottom: 4, alignSelf: "flex-start" },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: C.muted,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 14,
    textDecoration: "underline",
    textUnderlineOffset: 3,
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 9,
    width: "100%",
    marginBottom: 4,
  },
  tabBar: {
    display: "flex",
    gap: 6,
    width: "100%",
    background: C.surface2,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    background: "transparent",
    border: "none",
    color: C.muted,
    fontSize: 13,
    fontWeight: 700,
    padding: "8px 10px",
    borderRadius: 7,
    cursor: "pointer",
  },
  tabActive: { background: C.surface, color: C.text },
  googleBtn: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    background: "#fff",
    color: "#1f1f1f",
    border: "1px solid #dadce0",
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    marginBottom: 0,
  },
  divider: { display: "flex", alignItems: "center", gap: 10, width: "100%", margin: "16px 0" },
  dividerLine: { flex: 1, height: 1, background: C.line },
  dividerText: { color: C.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  pane: {
    padding: "30px 24px 30px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    minHeight: 360,
    justifyContent: "center",
  },
  tagline: { color: C.muted, fontSize: 14, maxWidth: 280, marginBottom: 18, lineHeight: 1.4 },
  roundLabel: {
    textTransform: "uppercase",
    letterSpacing: 2,
    fontSize: 12,
    color: C.muted,
    fontWeight: 700,
    marginBottom: 10,
  },
  aimLabel: { color: C.muted, fontSize: 13, letterSpacing: 1, marginBottom: 2 },
  bigNum: {
    fontFamily: mono,
    fontSize: 76,
    fontWeight: 700,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    margin: "4px 0 6px",
  },
  unit: { fontSize: 28, color: C.muted, marginLeft: 4 },
  sub: { color: C.muted, fontSize: 13, marginBottom: 22, maxWidth: 260, lineHeight: 1.4 },
  btnPrimary: {
    background: C.live,
    color: "#fff",
    border: "none",
    borderRadius: 999,
    padding: "15px 40px",
    fontSize: 16,
    fontWeight: 800,
    letterSpacing: 0.4,
    cursor: "pointer",
    marginTop: 8,
    width: "100%",
    maxWidth: 280,
  },
  btnGhost: {
    background: "transparent",
    color: C.muted,
    border: `1px solid ${C.line}`,
    borderRadius: 999,
    padding: "12px 28px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginTop: 12,
    width: "100%",
    maxWidth: 280,
  },
  donePill: {
    background: C.surface2,
    border: `1px solid ${C.line}`,
    color: C.cool,
    borderRadius: 999,
    padding: "12px 22px",
    fontWeight: 700,
    fontSize: 14,
  },
  hint: { color: C.muted, fontSize: 12, marginTop: 18, lineHeight: 1.5 },
  kbd: {
    fontFamily: mono,
    background: C.surface2,
    border: `1px solid ${C.line}`,
    borderRadius: 5,
    padding: "1px 6px",
    fontSize: 11,
  },
  // running void
  void: {
    width: "100%",
    minHeight: 360,
    background: "radial-gradient(120% 80% at 50% 42%, rgba(255,84,54,0.12), transparent 68%)",
    border: "none",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  livePill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 9,
    background: "rgba(255,84,54,0.14)",
    border: `1px solid ${C.live}`,
    color: C.live,
    borderRadius: 999,
    padding: "7px 16px",
    fontSize: 13,
    fontWeight: 800,
    letterSpacing: 2,
  },
  liveDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: C.live,
    display: "block",
  },
  voidBig: {
    fontSize: 26,
    fontWeight: 800,
    color: C.text,
    letterSpacing: 0.3,
  },
  voidText: { color: "#5A6477", fontSize: 13, letterSpacing: 2, textTransform: "uppercase" },
  btnDemo: {
    background: "transparent",
    color: C.cool,
    border: `1px solid rgba(56,226,198,0.35)`,
    borderRadius: 999,
    padding: "11px 22px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    marginBottom: 14,
    width: "100%",
    maxWidth: 280,
  },
  // reveal
  verdict: { fontSize: 26, fontWeight: 800, marginBottom: 26, letterSpacing: 0.4 },
  track: {
    position: "relative",
    width: "100%",
    maxWidth: 320,
    height: 2,
    background: C.line,
    margin: "30px 0 54px",
  },
  mark: {
    position: "absolute",
    top: -9,
    width: 3,
    height: 20,
    transform: "translateX(-50%)",
    borderRadius: 2,
  },
  markLabel: {
    position: "absolute",
    top: -24,
    left: "50%",
    transform: "translateX(-50%)",
    fontFamily: mono,
    fontSize: 11,
    whiteSpace: "nowrap",
  },
  errRow: { display: "flex", alignItems: "baseline", gap: 10 },
  errWord: { color: C.muted, fontSize: 15, textTransform: "uppercase", letterSpacing: 1 },
  accLine: { color: C.muted, fontSize: 14, margin: "8px 0 24px" },
  // summary
  grid: { display: "flex", gap: 8, margin: "6px 0 22px", flexWrap: "wrap", justifyContent: "center" },
  cell: {
    width: 56,
    height: 56,
    borderRadius: 12,
    border: "1.5px solid",
    background: C.surface2,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  cellSub: { color: C.muted, fontSize: 10, letterSpacing: 1 },
  statRow: { display: "flex", gap: 10, width: "100%", maxWidth: 320, marginBottom: 22 },
  stat: {
    flex: 1,
    background: C.surface2,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: "12px 6px",
  },
  statLabel: { color: C.muted, fontSize: 11, marginTop: 3, letterSpacing: 0.5 },
  dotCallout: {
    background: "rgba(56,226,198,0.12)",
    border: `1px solid rgba(56,226,198,0.4)`,
    color: C.cool,
    borderRadius: 12,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 800,
    marginBottom: 18,
  },
  lifeWrap: {
    width: "100%",
    maxWidth: 320,
    borderTop: `1px solid ${C.line}`,
    paddingTop: 18,
    marginBottom: 22,
  },
  lifeRow: { display: "flex", gap: 10, width: "100%" },
  miniStat: {
    flex: 1,
    background: C.surface2,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
    padding: "11px 6px",
    textAlign: "center",
  },
  miniVal: { fontFamily: mono, fontSize: 17, fontWeight: 700 },
  miniLabel: { color: C.muted, fontSize: 10.5, marginTop: 4, letterSpacing: 0.4 },
  sparkWrap: { marginTop: 14 },
  sparkCaption: { color: C.muted, fontSize: 11, marginTop: 6, textAlign: "center" },
  homeStats: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 16,
    fontSize: 12.5,
    color: C.muted,
  },
  homeStatDiv: { color: C.line },
  biasWrap: { width: "100%", maxWidth: 320, marginBottom: 22 },
  biasLabelRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    color: C.text,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  biasTrack: { position: "relative", height: 8, background: C.surface2, borderRadius: 999, border: `1px solid ${C.line}` },
  biasCenter: { position: "absolute", left: "50%", top: -4, width: 2, height: 16, background: C.line },
  biasDot: {
    position: "absolute",
    top: "50%",
    width: 16,
    height: 16,
    borderRadius: "50%",
    transform: "translate(-50%,-50%)",
    transition: "left .5s cubic-bezier(.2,.8,.2,1)",
  },
  biasHint: { color: C.muted, fontSize: 12, marginTop: 12, lineHeight: 1.5 },
};

const css = `
@keyframes otdPulse {
  0% { box-shadow: 0 0 0 0 rgba(255,84,54,0.55); transform: scale(1); }
  70% { box-shadow: 0 0 0 26px rgba(255,84,54,0); transform: scale(1.05); }
  100% { box-shadow: 0 0 0 0 rgba(255,84,54,0); transform: scale(1); }
}
.otd-pulse { animation: otdPulse 1.6s ease-out infinite; }
@keyframes otdEnter {
  0% { opacity: 0; background-color: rgba(255,84,54,0.28); }
  35% { opacity: 1; }
  100% { background-color: transparent; }
}
.otd-enter { animation: otdEnter .3s ease-out; }
@keyframes otdSlide { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0);} }
.otd-slide { animation: otdSlide .45s cubic-bezier(.2,.8,.2,1) both; }
button:focus-visible { outline: 2px solid ${C.cool}; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .otd-pulse, .otd-slide, .otd-enter { animation: none !important; }
}
`;
