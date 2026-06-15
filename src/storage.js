import { supabase } from "./supabaseClient";

const LKEY = "onthedot:v1";

// ---- on this device ----
export function loadLocal() {
  try {
    const r = localStorage.getItem(LKEY);
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}
export function saveLocal(data) {
  try {
    localStorage.setItem(LKEY, JSON.stringify(data));
  } catch {
    /* private mode / storage full — ignore */
  }
}

// ---- on the account (Supabase) ----
export async function loadRemote(userId) {
  try {
    const { data, error } = await supabase
      .from("stats")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error("loadRemote:", error.message);
      return null;
    }
    return data?.data ?? null;
  } catch (e) {
    console.error(e);
    return null;
  }
}
export async function saveRemote(userId, data) {
  try {
    const { error } = await supabase.from("stats").upsert({
      user_id: userId,
      data,
      updated_at: new Date().toISOString(),
    });
    if (error) console.error("saveRemote:", error.message);
  } catch (e) {
    console.error(e);
  }
}

// ---- combine device + account stats, keeping the best of each ----
export function mergeStats(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const byDate = {};
  [...(a.history || []), ...(b.history || [])].forEach((h) => {
    if (h && h.date) byDate[h.date] = h;
  });
  const history = Object.values(byDate)
    .sort((x, y) => (x.date < y.date ? -1 : 1))
    .slice(-400);
  const minDef = (x, y) => {
    const v = Math.min(x ?? Infinity, y ?? Infinity);
    return isFinite(v) ? v : null;
  };
  return {
    lastDate: (a.lastDate || "") > (b.lastDate || "") ? a.lastDate : b.lastDate,
    streak: Math.max(a.streak || 0, b.streak || 0),
    longestStreak: Math.max(a.longestStreak || 0, b.longestStreak || 0),
    best: minDef(a.best, b.best),
    bestSingle: minDef(a.bestSingle, b.bestSingle),
    onTheDot: Math.max(a.onTheDot || 0, b.onTheDot || 0),
    plays: Math.max(a.plays || 0, b.plays || 0),
    totalRounds: Math.max(a.totalRounds || 0, b.totalRounds || 0),
    history,
  };
}
