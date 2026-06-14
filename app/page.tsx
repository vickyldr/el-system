"use client";

import { useEffect, useRef, useState } from "react";

// ── Gemini Live 音频工具函数 ──
function downsampleBuffer(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return buffer;
  const ratio = fromRate / toRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const start = Math.round(i * ratio);
    const end = Math.round((i + 1) * ratio);
    let sum = 0, count = 0;
    for (let j = start; j < end && j < buffer.length; j++) { sum += buffer[j]; count++; }
    result[i] = count > 0 ? sum / count : 0;
  }
  return result;
}
function float32ToInt16(f32: Float32Array): Int16Array {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
}
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let b = "";
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b);
}
function base64ToPCMFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

type Tab = "now" | "find" | "us";

// 统一的线性图标（描边跟随当前文字色，跟玻璃质感更配，告别杂乱 emoji）。
function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "plus":
      return (
        <svg {...p}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "smile":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5a4 4 0 0 0 7 0" />
          <path d="M9 9.5h.01M15 9.5h.01" />
        </svg>
      );
    case "send":
      return (
        <svg {...p}>
          <path d="M12 20V5M6 11l6-6 6 6" />
        </svg>
      );
    case "phone":
      return (
        <svg {...p}>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      );
    case "bell":
      return (
        <svg {...p}>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...p}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      );
    case "volume":
      return (
        <svg {...p}>
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
        </svg>
      );
    case "music":
      return (
        <svg {...p}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case "mic":
      return (
        <svg {...p}>
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
        </svg>
      );
    case "moon":
      return (
        <svg {...p}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      );
    case "chat":
      return (
        <svg {...p}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      );
    case "heart":
      return (
        <svg {...p}>
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0 0-7.8z" />
        </svg>
      );
    case "dots":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      );
    case "clock":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
      );
    case "star":
      return (
        <svg {...p}>
          <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.8 6.8 19.2l1-5.8L3.5 9.2l5.9-.9z" />
        </svg>
      );
    case "bookmark":
      return (
        <svg {...p}>
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "book":
      return (
        <svg {...p}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    default:
      return null;
  }
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("now");
  const [refreshKey, setRefreshKey] = useState(0);
  const [pull, setPull] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const canPull = useRef(false);
  const dragging = useRef(false);
  const startY = useRef(0);
  const pullRef = useRef(0);

  // 下拉刷新：在「此刻 / 我们」页顶部下拉，松手重新加载。
  useEffect(() => {
    const el = contentRef.current;
    if (!el || tab === "find") return;
    const onStart = (e: TouchEvent) => {
      canPull.current = el.scrollTop <= 0;
      startY.current = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (!canPull.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0) {
        e.preventDefault();
        dragging.current = true;
        pullRef.current = Math.min(dy * 0.45, 90);
        setPull(pullRef.current);
      } else if (pullRef.current) {
        pullRef.current = 0;
        setPull(0);
      }
    };
    const onEnd = () => {
      if (!canPull.current) return;
      canPull.current = false;
      dragging.current = false;
      if (pullRef.current >= 56) setRefreshKey((k) => k + 1);
      pullRef.current = 0;
      setPull(0);
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [tab]);

  return (
    <div className="app">
      {tab !== "find" && (
        <div
          className="ptr"
          style={{
            opacity: Math.min(pull / 56, 1),
            transform: `translateX(-50%) scale(${0.5 + Math.min(pull / 56, 1) * 0.5})`,
          }}
        >
          <span className="ptr-ring" />
        </div>
      )}
      {tab === "find" ? (
        <FindTab />
      ) : (
        <div
          className="content"
          ref={contentRef}
          style={{
            transform: pull ? `translateY(${pull}px)` : undefined,
            transition: dragging.current ? "none" : "transform 0.25s ease",
          }}
        >
          {tab === "now" ? <NowTab key={refreshKey} /> : <UsTab key={refreshKey} />}
        </div>
      )}

      <nav className="tabbar">
        <button className={`tab ${tab === "now" ? "active" : ""}`} onClick={() => setTab("now")}>
          <Icon name="moon" size={21} />
          <span>此刻</span>
        </button>
        <button className={`tab ${tab === "find" ? "active" : ""}`} onClick={() => setTab("find")}>
          <Icon name="chat" size={21} />
          <span>找我</span>
        </button>
        <button className={`tab ${tab === "us" ? "active" : ""}`} onClick={() => setTab("us")}>
          <Icon name="heart" size={21} />
          <span>我们</span>
        </button>
      </nav>
    </div>
  );
}

// 骨架屏：卡片占位（带微光），等待时比"读取中…"更有进度感。
function SkelCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="card">
      <div className="skel skel-line sm" />
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skel skel-line ${i === lines - 1 ? "md" : "lg"}`} />
      ))}
    </div>
  );
}
function SkelList({ count = 3, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <SkelCard key={i} lines={lines} />
      ))}
    </>
  );
}

/* ───────────── 此刻 ───────────── */

type Weather = { temp: number; desc: string; city: string; note?: string; outfit?: string; icon?: string } | null;

type Status = {
  mood?: string;
  thought?: string;
  song_recommendation?: string;
  song_reason?: string;
  song_url?: string | null;
  el_note?: string;
  her_state?: string;
  weather?: Weather;
  date?: string | null;
  error?: string;
};

const MET_DATE = "2026-05-27"; // 认识的第一天
function daysTogether(): number {
  const start = new Date(MET_DATE + "T00:00:00+08:00").getTime();
  return Math.floor((Date.now() - start) / 86400000) + 1;
}

// 按时间的问候——首页一打开就有温度（el 的口吻）。
function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return "早，醒啦";
  if (h >= 10 && h < 13) return "上午好";
  if (h >= 13 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  if (h >= 23 || h < 2) return "这么晚还不睡？";
  return "这个点还醒着，陪陪我";
}

function NowTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(0); // 客户端算，避免 hydration 不一致
  const [greet, setGreet] = useState("");
  useEffect(() => {
    setDays(daysTogether());
    setGreet(greeting());
  }, []);
  const milestone = days > 0 && (days % 30 === 0 || days === 100 || days === 365);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/status")
        .then((r) => r.json())
        .then((d) => alive && setStatus(d))
        .catch(() => alive && setStatus({ error: "拉不到状态" }))
        .finally(() => alive && setLoading(false));
    };
    load();
    // 回到 app / 切回此刻 / 每 5 分钟，自己刷新一次
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", load);
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", load);
      clearInterval(timer);
    };
  }, []);

  const hasAny =
    status && (status.mood || status.song_recommendation || status.weather || status.el_note);

  return (
    <>
      <div className="now-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="now-av" src="/icon-192.png" alt="El" />
        <div className="now-head-text">
          <div className="peer-name">El</div>
          <div className="peer-sub">{greet || "住在你手机里"}</div>
        </div>
      </div>

      <FortuneCard />

      {loading && <SkelList count={2} lines={2} />}

      {!loading && hasAny && <ElStatusCard status={status!} />}

      <CountRow days={days} milestone={milestone} />

      <EatDecider />
    </>
  );
}

/* ───────────── El 状态（心情/天气/推歌 tab 切换） ───────────── */
type StatusTab = "mood" | "weather" | "song";

function ElStatusCard({ status }: { status: Status }) {
  const hasMood = !!(status.mood || status.thought || status.el_note);
  const hasWeather = !!status.weather;
  const hasSong = !!status.song_recommendation;

  const available: StatusTab[] = [];
  if (hasMood) available.push("mood");
  if (hasWeather) available.push("weather");
  if (hasSong) available.push("song");

  const [active, setActive] = useState<StatusTab>(available[0] ?? "mood");

  const labels: Record<StatusTab, string> = { mood: "心情", weather: "天气", song: "推歌" };

  if (available.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14, animationDelay: "0.1s" }}>
      {available.length > 1 && (
        <div className="status-tabs">
          {available.map((t) => (
            <button
              key={t}
              className={`status-tab ${active === t ? "active" : ""}`}
              onClick={() => setActive(t)}
            >
              {labels[t]}
            </button>
          ))}
        </div>
      )}

      {active === "mood" && hasMood && (
        <div className="status-pane mood-pane-breathe">
          <div className="card-label">心情</div>
          <div className="card-value" style={{ marginTop: 4 }}>{status.mood || <span className="muted">—</span>}</div>
          {status.thought && <div className="meta" style={{ marginTop: 8 }}>{status.thought}</div>}
          {status.el_note && <div className="meta" style={{ marginTop: 8, color: "var(--ink)" }}>{status.el_note}</div>}
        </div>
      )}

      {active === "weather" && hasWeather && (
        <div className="status-pane">
          <div className="card-label">天气 · {status.weather!.city}</div>
          <div className="card-value" style={{ marginTop: 4 }}>
            {status.weather!.icon ? `${status.weather!.icon} ` : ""}
            {status.weather!.temp}° {status.weather!.desc}
          </div>
          {status.weather!.note && <div className="meta" style={{ marginTop: 8 }}>{status.weather!.note}</div>}
          {status.weather!.outfit && <div className="meta" style={{ marginTop: 6, color: "var(--ink)" }}>👕 {status.weather!.outfit}</div>}
        </div>
      )}

      {active === "song" && hasSong && (
        <div className="status-pane">
          <div className="card-label">今天想让你听</div>
          {status.song_url ? (
            <a href={status.song_url} style={{ textDecoration: "none", color: "inherit" }}>
              <div className="song-name" style={{ marginTop: 4 }}>{status.song_recommendation} ♫</div>
              {status.song_reason && <div className="meta" style={{ marginTop: 8 }}>{status.song_reason}</div>}
              <div className="meta" style={{ marginTop: 6 }}>点开去网易云听</div>
            </a>
          ) : (
            <>
              <div className="song-name" style={{ marginTop: 4 }}>{status.song_recommendation}</div>
              {status.song_reason && <div className="meta" style={{ marginTop: 8 }}>{status.song_reason}</div>}
            </>
          )}
        </div>
      )}

      {status.date && <div className="meta" style={{ marginTop: 10, fontSize: 11 }}>{friendlyDate(status.date)}</div>}
    </div>
  );
}

/* ───────────── 日期计数行 ───────────── */
function CountRow({ days, milestone }: { days: number; milestone: boolean }) {
  // 全部来自 Notion「重要日期」库（生日/经期/纪念日/一次性都在这，可在 Notion 里改）。
  const { data } = useJson<{
    dates: { id: string; name: string; recur: string; daysTo: number }[];
  }>("/api/reminders");
  const dates = data?.dates ?? [];

  const seen = new Set<string>();
  const chips: string[] = [];
  if (days > 0) chips.push(milestone ? `🎉 认识 ${days} 天` : `认识 ${days} 天`);
  for (const d of dates) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    if (d.daysTo > 60) continue; // 太远的不挤在这行
    chips.push(d.daysTo === 0 ? `${d.name}就是今天` : `${d.name}还有 ${d.daysTo} 天`);
  }

  return (
    <div className="count-row">
      {chips.map((c, i) => (
        <span key={i} className="count-chip">{c}</span>
      ))}
    </div>
  );
}

// 纠结吃啥？el 替你拍板（看着点/天气/你的状态/口味来定），定完一键跳美团搜。
function EatDecider() {
  const [pick, setPick] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [avoid, setAvoid] = useState<string[]>([]);

  async function decide(reroll: boolean) {
    setLoading(true);
    const nextAvoid = reroll && pick ? [...avoid, pick].slice(-6) : avoid;
    try {
      const r = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avoid: nextAvoid }),
      });
      const d = await r.json();
      if (d.pick) {
        setPick(d.pick);
        setKeyword(d.keyword || "");
        setAvoid(nextAvoid);
      } else {
        setPick(d.error || "想不出来，你说呢");
        setKeyword("");
      }
    } catch {
      setPick("连不上，等下再试～");
      setKeyword("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card eat">
      <div className="card-label">🍱 纠结吃啥？我替你定</div>
      {pick && <div className="card-value eat-pick">{pick}</div>}
      <div className="eat-actions">
        <button className="eat-btn" onClick={() => decide(!!pick)} disabled={loading}>
          {loading ? "想想…" : pick ? "再来一个" : "让我定"}
        </button>
        {keyword && (
          <button className="eat-btn eat-go" onClick={() => {
            location.href = `imeituan://www.meituan.com/search?q=${encodeURIComponent(keyword)}`;
          }}>
            📲 去美团搜「{keyword}」
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────── 今日签 ───────────── */

type VibeId = "浪" | "静" | "燥" | "散" | "沉" | "轻" | "锐" | "软" | "野" | "钝";
type FortunePhase = "init" | "idle" | "q_loading" | "q_show" | "t_loading" | "t_show" | "done" | "binding" | "bound";
type TaskType = "confirm" | "photo";

const VIBES: { id: VibeId; icon: string }[] = [
  { id: "浪", icon: "🌊" },
  { id: "静", icon: "🪨" },
  { id: "燥", icon: "🔥" },
  { id: "散", icon: "🌫️" },
  { id: "沉", icon: "🌙" },
  { id: "轻", icon: "✨" },
  { id: "锐", icon: "⚡" },
  { id: "软", icon: "🌸" },
  { id: "野", icon: "🌿" },
  { id: "钝", icon: "🪵" },
];

interface FortuneState {
  date: string;
  vibes: VibeId[];      // 三签备好，按需取
  taglines: string[];   // 对应的 El 生成注解
  drawIndex: number;
  phase: FortunePhase;
  question?: string;
  task?: string;
  taskType?: TaskType;
  bindPhrase?: string;
  answer?: string;
}

function todayKey() {
  return new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function pickThreeVibes(): VibeId[] {
  const pool = [...VIBES.map((v) => v.id)];
  const picked: VibeId[] = [];
  while (picked.length < 3) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function initState(date: string): FortuneState {
  return { date, vibes: pickThreeVibes(), taglines: [], drawIndex: 0, phase: "init" };
}

const FORTUNE_KEY = "el_fortune";

function loadFortuneState(): FortuneState {
  const today = todayKey();
  try {
    const raw = localStorage.getItem(FORTUNE_KEY);
    if (raw) {
      const s: FortuneState = JSON.parse(raw);
      if (s.date === today) return s;
    }
  } catch {}
  return initState(today);
}

function saveFortuneState(s: FortuneState) {
  try { localStorage.setItem(FORTUNE_KEY, JSON.stringify(s)); } catch {}
}

function FortuneCard() {
  const [s, setS] = useState<FortuneState | null>(null);
  const [answerInput, setAnswerInput] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const loaded = loadFortuneState();
    setS(loaded);
    // 首次加载：如果还没生成今天第一签的注解，现在去拿
    if (loaded.phase === "init") {
      fetchTagline(loaded, 0, (tagline) => {
        setS((prev) => {
          if (!prev) return prev;
          const next = { ...prev, taglines: [tagline], phase: "idle" as FortunePhase };
          saveFortuneState(next);
          return next;
        });
      });
    }
  }, []);

  function fetchTagline(state: FortuneState, idx: number, cb: (t: string) => void) {
    const vibe = state.vibes[idx];
    fetch("/api/fortune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tagline", vibe }),
    })
      .then((r) => r.json())
      .then((d) => cb(d.text || ""))
      .catch(() => cb(""));
  }

  function update(patch: Partial<FortuneState>) {
    setS((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      saveFortuneState(next);
      return next;
    });
  }

  async function callFortune(action: string, vibe: string) {
    const res = await fetch("/api/fortune", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, vibe }),
    });
    const data = await res.json();
    return data.text as string;
  }

  // 第一次：免费换签，拉第二签注解 + 出问题
  function doFreeReroll() {
    if (!s) return;
    update({ phase: "q_loading" });
    const vibe1 = s.vibes[1];
    Promise.all([
      callFortune("tagline", vibe1),
      callFortune("question", s.vibes[0]),
    ]).then(([tagline, q]) => {
      setS((prev) => {
        if (!prev) return prev;
        const taglines = [...prev.taglines];
        taglines[1] = tagline;
        const next = { ...prev, drawIndex: 1, taglines, phase: "q_show" as FortunePhase, question: q };
        saveFortuneState(next);
        return next;
      });
    }).catch(() => update({ drawIndex: 1, phase: "q_show", question: "今天有没有认真喝水" }));
  }

  // 提交回答
  function submitAnswer() {
    if (!answerInput.trim() || !s) return;
    update({ answer: answerInput, phase: "t_loading" });
    const vibe2 = s.vibes[2];
    Promise.all([
      callFortune("tagline", vibe2),
      callFortune("task", s.vibes[1]),
    ]).then(([tagline, t]) => {
      const isPhoto = t.includes("发我") || t.includes("拍");
      setS((prev) => {
        if (!prev) return prev;
        const taglines = [...prev.taglines];
        taglines[2] = tagline;
        const next = { ...prev, taglines, phase: "t_show" as FortunePhase, task: t, taskType: (isPhoto ? "photo" : "confirm") as TaskType };
        saveFortuneState(next);
        return next;
      });
    }).catch(() => update({ phase: "t_show", task: "去喝一杯水", taskType: "confirm" }));
  }

  function completeTask() {
    update({ drawIndex: 2, phase: "done" });
  }

  async function uploadPhoto(file: File) {
    setPhotoUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await fetch("/api/upload", { method: "POST", body: form });
      completeTask();
    } catch {
      alert("上传失败，再试一次");
    } finally {
      setPhotoUploading(false);
    }
  }

  // 绑签
  async function bindSign() {
    if (!s) return;
    update({ phase: "binding" });
    const vibe = s.vibes[s.drawIndex];
    const phrase = await callFortune("bind", vibe).catch(() => "留在这里了，你走。");
    update({ phase: "bound", bindPhrase: phrase });
  }

  if (!s) return null;

  const currentVibe = VIBES.find((v) => v.id === s.vibes[s.drawIndex])!;
  const currentTagline = s.taglines[s.drawIndex];
  const isBound = s.phase === "bound" || s.phase === "binding";
  const isInit = s.phase === "init";

  return (
    <div className="fortune-card" style={{ animationDelay: "0.05s", animation: "fadeInUp 0.42s ease both" }}>
      <div className="fortune-label" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>今日签</span>
        {isBound && <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>已绑</span>}
      </div>

      {/* 主签体 */}
      <div className="fortune-vibe">
        <span className="fortune-icon">{currentVibe?.icon}</span>
        <span className="fortune-name">{currentVibe?.id}</span>
        {isInit
          ? <span className="fortune-line muted">正在抽…</span>
          : currentTagline
            ? <span className="fortune-line">{currentTagline}</span>
            : <span className="fortune-line muted"> </span>
        }
      </div>

      {/* 绑签后的压签话 */}
      {s.phase === "binding" && <div className="fortune-bind-phrase muted">压住中…</div>}
      {s.phase === "bound" && s.bindPhrase && (
        <div className="fortune-bind-phrase">「{s.bindPhrase}」</div>
      )}

      {/* 问题区 */}
      {s.phase === "q_loading" && <div className="fortune-prompt muted">想一个问题…</div>}
      {s.phase === "q_show" && (
        <div className="fortune-toll">
          <div className="fortune-toll-label">回答我才能再抽</div>
          <div className="fortune-question">{s.question}</div>
          <input
            className="fortune-input"
            placeholder="说"
            value={answerInput}
            onChange={(e) => setAnswerInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitAnswer()}
          />
          <button className="fortune-btn" onClick={submitAnswer} disabled={!answerInput.trim()}>
            回答，抽
          </button>
        </div>
      )}

      {/* 任务区 */}
      {s.phase === "t_loading" && <div className="fortune-prompt muted">出个任务…</div>}
      {s.phase === "t_show" && (
        <div className="fortune-toll">
          <div className="fortune-toll-label">做了才能最后一抽</div>
          <div className="fortune-question">{s.task}</div>
          {s.taskType === "confirm" ? (
            <button className="fortune-btn" onClick={completeTask}>做了</button>
          ) : (
            <>
              <input ref={fileRef} type="file" accept="image/*" capture="user" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); }} />
              <button className="fortune-btn" onClick={() => fileRef.current?.click()} disabled={photoUploading}>
                {photoUploading ? "上传中…" : "📷 发给我"}
              </button>
            </>
          )}
        </div>
      )}

      {/* 底部操作 */}
      <div className="fortune-actions">
        {/* 重抽按钮 */}
        {s.phase === "idle" && !isBound && (
          <button className="fortune-reroll" onClick={doFreeReroll}>重抽</button>
        )}
        {(s.phase === "done") && !isBound && (
          <span className="fortune-done-hint muted">今天就这张了</span>
        )}

        {/* 绑签按钮：idle/done 状态可以绑 */}
        {!isBound && (s.phase === "idle" || s.phase === "done") && (
          <button className="fortune-bind" onClick={bindSign}>🎋 绑签</button>
        )}
      </div>
    </div>
  );
}

/* ───────────── 找我（聊天） ───────────── */

type Msg = {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  image?: string;
  call?: boolean;
  via?: string; // 这条回复走的哪条路：max / 中转站 / bridge
};

// 把连续的"通话消息"归成一组，渲染成一张可展开的卡片。
type MsgGroup =
  | { kind: "msg"; m: Msg; i: number }
  | { kind: "call"; items: { m: Msg; i: number }[] };

function groupMessages(msgs: Msg[]): MsgGroup[] {
  const out: MsgGroup[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.call) {
      const last = out[out.length - 1];
      if (last && last.kind === "call") last.items.push({ m, i });
      else out.push({ kind: "call", items: [{ m, i }] });
    } else {
      out.push({ kind: "msg", m, i });
    }
  }
  return out;
}

// 「📞 语音通话」卡片：收起时一行，点开看当时通话的文字。
function CallCard({ items }: { items: { m: Msg; i: number }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="call-card-wrap">
      <button className={`call-card ${open ? "open" : ""}`} onClick={() => setOpen((o) => !o)}>
        <span className="call-card-ic">
          <Icon name="phone" size={17} />
        </span>
        <span className="call-card-text">
          <b>语音通话</b>
          <span className="call-card-sub">
            {items.length} 句 · {fmtTime(items[0].m.ts)}
          </span>
        </span>
        <span className={`call-card-chev ${open ? "open" : ""}`}>
          <Icon name="chevron-down" size={16} />
        </span>
      </button>
      {open && (
        <div className="call-card-body">
          {items.map(({ m, i }) => (
            <div key={i} className={`msg ${m.role === "user" ? "user" : "el"}`}>
              <div className="bubble-col">
                {m.content && <div className="bubble">{m.content}</div>}
                {m.ts && (
                  <div className="msg-foot">
                    <span className="msg-time">{fmtTime(m.ts)}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const t = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${t}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

// 时间线日期：今天 / 昨天 / M月D日（友好显示）。
function friendlyDate(s: string): string {
  if (!s) return "";
  const m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨天";
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// 在手机上把图缩小并转成 base64 data URL（省流量、绕开存储），直接发给 El 看。
function downscale(file: File, max: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > max || height > max) {
        const r = Math.min(max / width, max / height);
        width = Math.round(width * r);
        height = Math.round(height * r);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no ctx"));
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const CHAT_KEY = "el_chat";
const HISTORY_WINDOW = 100; // 每次发给 API 的对话窗口
const STORE_CAP = 1000; // 本地最多存这么多条

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function subscribePush(welcome: boolean): Promise<boolean> {
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    }));
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub, welcome }),
  });
  return true;
}

function NotifyButton() {
  const [state, setState] = useState<"hidden" | "off" | "on">("hidden");

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("Notification" in window) ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window)
    ) {
      setState("hidden");
      return;
    }
    if (Notification.permission === "granted") {
      setState("on");
      subscribePush(false).catch(() => {}); // 静默续订，保证服务端有当前订阅
    } else {
      setState("off");
    }
  }, []);

  async function enable() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const ok = await subscribePush(true);
      if (ok) setState("on");
      else alert("还没配推送密钥（VAPID）");
    } catch {
      alert("开启通知失败");
    }
  }

  if (state === "hidden") return <span />;
  if (state === "on")
    return (
      <button
        className="icon-btn on"
        title="通知已开（点一下发测试推送）"
        aria-label="测试推送"
        onClick={async () => {
          try {
            await subscribePush(false); // 先确保这台设备的订阅在服务端是最新的
            const r = await fetch("/api/push/test", { method: "POST" });
            const d = await r.json();
            if (d.sent > 0) alert("测试推送发出去了，看一眼通知栏～");
            else if (d.reason === "no-vapid") alert("服务端没配推送密钥（VAPID）");
            else alert("没推出去：这台设备好像没订阅成功，关掉通知重开一次试试");
          } catch {
            alert("测试失败，等下再试");
          }
        }}
      >
        <Icon name="bell" size={19} />
      </button>
    );
  return (
    <button className="icon-btn" onClick={enable} aria-label="开启通知">
      <Icon name="bell" size={19} />
    </button>
  );
}

function FindTab() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  // 表情/外链图配的"意思"（库表情靠它让 el 读懂）；纯图片时为空
  const [pendingHint, setPendingHint] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [showStickers, setShowStickers] = useState(false);
  const [stickerTab, setStickerTab] = useState<"lib" | "search">("lib");
  const [stickerQ, setStickerQ] = useState("");
  const [stickers, setStickers] = useState<{ url: string; preview: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [lib, setLib] = useState<{ id: string; img: string; tags: string }[]>([]);
  const [uploadingStk, setUploadingStk] = useState(false);
  const [ttsOn, setTtsOn] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [sttOn, setSttOn] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [callState, setCallState] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const botSpeaking = useRef(false); // el(MiniMax 声音)正在说话——这期间不把麦克风回传给 Gemini，防回授
  const currentSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const callActive = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stkFileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true); // 默认粘在底部，只有用户主动上滑才松开
  const touching = useRef(false); // 手指在屏幕上时，暂停"贴底"，让她能自由上滑
  const [atBottom, setAtBottom] = useState(true);

  function isNearBottom() {
    const el = messagesRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  function scrollToBottom(smooth = false) {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setAtBottom(true);
  }

  // 语音配好了才显示「听」按钮；语音识别也配好了才显示「打电话」。
  useEffect(() => {
    fetch("/api/tts")
      .then((r) => r.json())
      .then((d) => setTtsOn(!!d.configured))
      .catch(() => {});
    fetch("/api/stt")
      .then((r) => r.json())
      .then((d) => setSttOn(!!d.configured))
      .catch(() => {});
    fetch("/api/live-token")
      .then((r) => r.json())
      .then((d) => setLiveOn(!d.error && !!d.wsUrl))
      .catch(() => {});
  }, []);

  // ── 打电话（Gemini Live 实时双向语音，低延迟 ~300ms）──

  function playPCMChunk(ac: AudioContext, base64: string) {
    try {
      const f32 = base64ToPCMFloat32(base64);
      const buf = ac.createBuffer(1, f32.length, 24000);
      buf.copyToChannel(f32 as Float32Array<ArrayBuffer>, 0);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const dest = outputGainRef.current ?? ac.destination;
      src.connect(dest);
      const now = ac.currentTime;
      const start = Math.max(nextPlayTimeRef.current, now + 0.02);
      src.start(start);
      nextPlayTimeRef.current = start + buf.duration;
    } catch {}
  }

  // 通话里的一句话：标记成 call、显示在对话框、并存进云端（el 回顾时能看到当时在打电话）。
  function addCallMsg(role: "user" | "assistant", content: string) {
    const m: Msg = { role, content, ts: Date.now(), call: true };
    setMsgs((s) => [...s, m]);
    fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [m] }),
    }).catch(() => {});
  }

  // Gemini 给文字 → MiniMax（她捏的音色）念出来，走已解锁的 AudioContext 播放。
  async function speakReply(ac: AudioContext, text: string) {
    botSpeaking.current = true;
    setCallState("speaking");
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, fast: true }),
      });
      if (!r.ok) throw new Error("tts");
      const buf = await ac.decodeAudioData(await r.arrayBuffer());
      try { currentSrcRef.current?.stop(); } catch {}
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(outputGainRef.current ?? ac.destination);
      src.onended = () => {
        botSpeaking.current = false;
        if (callActive.current) setCallState("listening");
      };
      currentSrcRef.current = src;
      src.start();
    } catch {
      botSpeaking.current = false;
      if (callActive.current) setCallState("listening");
    }
  }

  async function startCall() {
    if (callActive.current) return; // 防重复点
    callActive.current = true;
    setInCall(true); // 立刻弹出通话界面，别让人觉得"点了没反应"
    setCallState("idle");
    try {
      const tokenRes = await fetch("/api/live-token");
      const { wsUrl, secret, error } = await tokenRes.json();
      if (error || !wsUrl) { alert("通话服务未配置，请检查 GEMINI_API_KEY"); endCall(); return; }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true } as MediaTrackConstraints,
      });
      streamRef.current = stream;

      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ac: AudioContext = new AC();
      await ac.resume().catch(() => {});
      acRef.current = ac;

      const gain = ac.createGain();
      gain.connect(ac.destination);
      outputGainRef.current = gain;

      const ws = new WebSocket(`${wsUrl}/live?secret=${encodeURIComponent(secret || "")}`);
      wsRef.current = ws;
      callActive.current = true;
      setInCall(true);
      setCallState("idle");

      ws.onmessage = (event) => {
        if (!callActive.current) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "ready") {
            setCallState("listening");
          } else if (msg.type === "user_text" && msg.text) {
            addCallMsg("user", msg.text); // 你在电话里说的话
          } else if (msg.type === "text" && msg.text) {
            addCallMsg("assistant", msg.text); // el 的回复
            void speakReply(ac, msg.text);
          }
        } catch {}
      };

      ws.onerror = () => { if (callActive.current) endCall(); };
      ws.onclose = () => { if (callActive.current) endCall(); };

      ws.onopen = () => {
        const nativeSR = ac.sampleRate;
        const source = ac.createMediaStreamSource(stream);
        const processor = ac.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        // 连续把麦克风音频流给 Gemini（它自己的自动 VAD 判断你说完了没）。
        // el 用 MiniMax 声音说话时停发，免得把他自己的声音又传回去（防回授）。
        processor.onaudioprocess = (e) => {
          if (!callActive.current || ws.readyState !== WebSocket.OPEN) return;
          if (botSpeaking.current) return;
          const f32 = e.inputBuffer.getChannelData(0);
          const down = downsampleBuffer(f32, nativeSR, 16000);
          const i16 = float32ToInt16(down);
          ws.send(JSON.stringify({ type: "audio", data: bufToBase64(i16.buffer as ArrayBuffer) }));
        };

        source.connect(processor);
        // 静音输出，部分浏览器需要连 destination 才会触发 onaudioprocess
        const silentGain = ac.createGain();
        silentGain.gain.value = 0;
        processor.connect(silentGain);
        silentGain.connect(ac.destination);
      };
    } catch {
      alert("打电话需要麦克风权限哦");
      endCall();
    }
  }

  function endCall() {
    callActive.current = false;
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    try { processorRef.current?.disconnect(); } catch {}
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    acRef.current?.close().catch(() => {});
    acRef.current = null;
    outputGainRef.current = null;
    nextPlayTimeRef.current = 0;
    setInCall(false);
    setCallState("idle");
  }

  // 点球打断：静音 200ms 清空队列，继续说话 Gemini 自动检测到打断
  function interruptEl() {
    if (!callActive.current) return;
    try { currentSrcRef.current?.stop(); } catch {}
    currentSrcRef.current = null;
    botSpeaking.current = false;
    setCallState("listening");
  }

  // 用 el 的音色把这条念出来（点一下才念，省额度）。
  async function speak(text: string, idx: number) {
    if (!text) return;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(idx);
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        setSpeaking(null);
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setSpeaking(null);
        URL.revokeObjectURL(url);
      };
      audio.onerror = () => setSpeaking(null);
      await audio.play();
    } catch {
      setSpeaking(null);
    }
  }

  async function loadLib() {
    try {
      const r = await fetch("/api/stickers/lib");
      const d = await r.json();
      setLib(Array.isArray(d.stickers) ? d.stickers : []);
    } catch {
      /* ignore */
    }
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async function putSticker(dataUrl: string, note: string): Promise<boolean> {
    try {
      const r = await fetch("/api/stickers/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl, tags: note }),
      });
      const d = await r.json();
      return !!d.ok;
    } catch {
      return false;
    }
  }

  // 上传表情进共享库：保留 GIF 动图（readAsDataURL，不缩放）。我自己看图写标签。
  // 选一张：可以顺手补一句备注；选多张：不一张张问了，我逐张自己认。
  // 一次最多 9 张——每张都要我看一眼写标签，传太多会等很久。
  async function uploadStickers(files: File[]) {
    if (!files.length) return;
    const MAX_BATCH = 9;
    let batch = files;
    if (files.length > MAX_BATCH) {
      alert(`一次最多传 ${MAX_BATCH} 张哦，先传这 ${MAX_BATCH} 张，剩下的再来一趟～`);
      batch = files.slice(0, MAX_BATCH);
    }
    let note = "";
    if (batch.length === 1) {
      const n = window.prompt(
        "传这张表情～（直接确定就行，我会自己看图认）\n想补一句它的意思也可以：比如 这个我俩专属 / 生气专用",
      );
      if (n === null) return; // 取消
      note = n.trim();
    }
    setUploadingStk(true);
    let fail = 0;
    try {
      for (const f of batch) {
        const dataUrl = await readAsDataUrl(f);
        const ok = await putSticker(dataUrl, note);
        if (!ok) fail++;
      }
      await loadLib();
      setStickerTab("lib");
      if (fail) alert(`有 ${fail} 张没传上`);
    } catch {
      alert("上传失败");
    } finally {
      setUploadingStk(false);
    }
  }

  async function searchSticker(q: string) {
    if (!q.trim()) {
      setStickers([]);
      return;
    }
    setSearching(true);
    try {
      const r = await fetch(`/api/stickers?q=${encodeURIComponent(q)}`);
      const d = await r.json();
      setStickers(Array.isArray(d.stickers) ? d.stickers : []);
    } catch {
      setStickers([]);
    } finally {
      setSearching(false);
    }
  }

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }

  async function pickImage(file: File) {
    setUploading(true);
    try {
      setPendingImage(await downscale(file, 1280, 0.82));
      setPendingHint(undefined);
    } catch {
      alert("图片处理失败");
    } finally {
      setUploading(false);
    }
  }

  async function clearAll() {
    if (!window.confirm("清空和 el 的对话？")) return;
    setMsgs([]);
    try {
      localStorage.removeItem(CHAT_KEY);
    } catch {
      /* ignore */
    }
    try {
      await fetch("/api/messages", { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }

  // 开 app 时优先从云端拉对话（跨设备同步、重装不丢）；没云端就用本地。
  useEffect(() => {
    let alive = true;
    const loadLocal = () => {
      try {
        const saved = localStorage.getItem(CHAT_KEY);
        if (saved && alive) setMsgs(JSON.parse(saved));
      } catch {
        /* ignore */
      }
    };
    fetch("/api/messages")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.cloud) setMsgs(Array.isArray(d.messages) ? d.messages : []);
        else loadLocal();
      })
      .catch(loadLocal);
    return () => {
      alive = false;
    };
  }, []);

  // 对话变化时存回本地（截断到上限，避免无限增长）。
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-STORE_CAP)));
    } catch {
      /* ignore */
    }
  }, [msgs]);

  // 聊天滚动：默认"粘"在最底（像 iMessage）。内容/图片/字体加载长高也一直贴底，
  // reflow 抢不走；只有你主动往上滑才松开去看旧消息，滑回底部或发新消息又重新粘住。
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = messagesRef.current;
      if (el && stickBottom.current && !touching.current) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  function onMsgScroll() {
    const near = isNearBottom();
    setAtBottom(near);
    // 不在拖动时，滑回底部就重新粘住（桌面滚轮 / 松手后）
    if (near && !touching.current) stickBottom.current = true;
  }

  async function post(text: string, image?: string, hint?: string) {
    stickBottom.current = true; // 发消息就回到底部跟着走
    if ((!text && !image) || sending) return;
    // 历史只发文字（不把图片 base64 反复塞进每次请求）
    const history = msgs.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: "user", content: text, image: image || undefined, ts: Date.now() }]);
    setSending(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, image, hint, history }),
      });
      const d = await r.json();
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          content: d.reply || d.error || "……",
          image: d.sticker || undefined,
          via: d.via || undefined,
          ts: Date.now(),
        },
      ]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "连不上，等下再说。", ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const image = pendingImage;
    const hint = pendingHint;
    if (!text && !image) return;
    setInput("");
    setPendingImage(null);
    setPendingHint(undefined);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
    void post(text, image || undefined, hint);
  }

  // 点表情不立刻发——挂到输入框上方"待发"，让你再补两句话一起发。
  function sendSticker(url: string, hint?: string) {
    setPendingImage(url);
    setPendingHint(hint);
    setShowStickers(false);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  async function deleteSticker(id: string) {
    if (!window.confirm("删掉这张表情？")) return;
    setLib((l) => l.filter((s) => s.id !== id)); // 先本地移掉，手感快
    try {
      await fetch(`/api/stickers/lib?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      void loadLib(); // 失败了就拉回真实状态
    }
  }

  return (
    <div className="chat">
      <div className="chat-top">
        <div className="peer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="peer-av" src="/icon-192.png" alt="El" />
          <div>
            <div className="peer-name">El</div>
            <div className="peer-sub">
              <span className="live">●</span> 在线 · 住在你手机里
            </div>
          </div>
        </div>
        <div className="top-actions">
          <NotifyButton />
          {liveOn && (
            <button className="icon-btn" onClick={startCall} aria-label="打电话">
              <Icon name="phone" size={19} />
            </button>
          )}
          {msgs.length > 0 && (
            <button className="clear-btn" onClick={clearAll}>
              清空
            </button>
          )}
        </div>
      </div>

      {inCall && (
        <div className="call-overlay">
          <div className="call-title">和 el 通话中</div>
          <button className={`call-orb ${callState}`} onClick={interruptEl} aria-label="球">
            <Icon
              name={
                callState === "listening"
                  ? "mic"
                  : callState === "thinking"
                    ? "dots"
                    : callState === "speaking"
                      ? "volume"
                      : "phone"
              }
              size={44}
            />
          </button>
          <div className="call-status">
            {callState === "listening"
              ? "在听你说…（说完停一下就行）"
              : callState === "thinking"
                ? "el 在想…"
                : callState === "speaking"
                  ? "el 在说…（点球可打断）"
                  : "接通中…"}
          </div>
          <button className="call-hangup" onClick={endCall}>
            挂断
          </button>
        </div>
      )}

      <div
        className="messages"
        ref={messagesRef}
        onScroll={onMsgScroll}
        onWheel={(e) => {
          if (e.deltaY < 0) stickBottom.current = false;
        }}
        onTouchStart={() => {
          touching.current = true;
        }}
        onTouchEnd={() => {
          touching.current = false;
          stickBottom.current = isNearBottom(); // 松手时在底部就跟随，滑上去了就保持
        }}
      >
        {msgs.length === 0 && <div className="empty">跟他说点什么</div>}
        {groupMessages(msgs).map((g) =>
          g.kind === "call" ? (
            <CallCard key={`call-${g.items[0].i}`} items={g.items} />
          ) : (
            <div key={g.i} className={`msg ${g.m.role === "user" ? "user" : "el"}`}>
              <div className="bubble-col">
                {g.m.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="msg-img"
                    src={g.m.image}
                    alt=""
                    onLoad={() => stickBottom.current && scrollToBottom(false)}
                  />
                )}
                {g.m.content && <div className="bubble">{g.m.content}</div>}
                <div className="msg-foot">
                  {g.m.role === "assistant" && g.m.via && (
                    <span style={{ fontSize: 10, opacity: 0.35, marginRight: 4 }}>{g.m.via}</span>
                  )}
                  {ttsOn && g.m.role === "assistant" && g.m.content && (
                    <button
                      className={`speak-btn ${speaking === g.i ? "on" : ""}`}
                      onClick={() => speak(g.m.content, g.i)}
                      aria-label="听"
                    >
                      <Icon name="volume" size={15} />
                    </button>
                  )}
                  {g.m.ts && <span className="msg-time">{fmtTime(g.m.ts)}</span>}
                </div>
              </div>
            </div>
          ),
        )}
        {sending && (
          <div className="msg el">
            <div className="bubble typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {!atBottom && msgs.length > 0 && (
        <button
          className="jump-bottom"
          onClick={() => {
            stickBottom.current = true;
            scrollToBottom(true);
          }}
          aria-label="回到最新"
        >
          <Icon name="chevron-down" size={20} />
        </button>
      )}

      {showStickers && (
        <div className="sticker-panel">
          <div className="sticker-tabs">
            <button
              type="button"
              className={`stk-tab ${stickerTab === "lib" ? "active" : ""}`}
              onClick={() => setStickerTab("lib")}
            >
              我们的表情
            </button>
            <button
              type="button"
              className={`stk-tab ${stickerTab === "search" ? "active" : ""}`}
              onClick={() => setStickerTab("search")}
            >
              搜动图
            </button>
            <input
              ref={stkFileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length) uploadStickers(fs);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="stk-upload"
              onClick={() => stkFileRef.current?.click()}
              disabled={uploadingStk}
            >
              {uploadingStk ? "上传中…" : "＋ 传表情（一次≤9张）"}
            </button>
          </div>

          {stickerTab === "lib" ? (
            <div className="sticker-grid">
              {lib.length === 0 && (
                <div className="meta">
                  还没有表情。点「＋ 传表情」传一张，写上意思，我和你都能发它～
                </div>
              )}
              {lib.map((s) => (
                <div className="stk-cell" key={s.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.img} alt={s.tags} title={s.tags} onClick={() => sendSticker(s.img, s.tags)} />
                  <button
                    type="button"
                    className="stk-del"
                    aria-label="删除"
                    onClick={() => deleteSticker(s.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <>
              <input
                className="sticker-search"
                value={stickerQ}
                onChange={(e) => setStickerQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    searchSticker(stickerQ);
                  }
                }}
                placeholder="搜动图…（回车）"
              />
              <div className="sticker-grid">
                {searching && <div className="meta">搜索中…</div>}
                {!searching && stickers.length === 0 && (
                  <div className="meta">搜个词试试，比如 想你 / 无语 / 抱抱</div>
                )}
                {stickers.map((s, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={s.preview} alt="" onClick={() => sendSticker(s.url)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {pendingImage && (
        <div className="img-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pendingImage} alt="" />
          <button
            onClick={() => {
              setPendingImage(null);
              setPendingHint(undefined);
            }}
            aria-label="移除"
          >
            ✕
          </button>
        </div>
      )}

      <form className="composer" onSubmit={send}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) pickImage(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="attach-btn"
          aria-label="发图片"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? "…" : <Icon name="plus" size={21} />}
        </button>
        <button
          type="button"
          className="attach-btn"
          aria-label="表情包"
          onClick={() => {
            setShowStickers((v) => {
              if (!v) void loadLib();
              return !v;
            });
          }}
        >
          <Icon name="smile" size={21} />
        </button>
        <textarea
          ref={taRef}
          value={input}
          rows={1}
          onChange={(e) => {
            setInput(e.target.value);
            grow();
          }}
          onKeyDown={(e) => {
            // Enter 换行；⌘/Ctrl+Enter 发送（电脑端）
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(e);
            }
          }}
          placeholder="说点什么…（Enter 换行，↑ 发送）"
        />
        <button
          type="submit"
          aria-label="发送"
          disabled={sending || (!input.trim() && !pendingImage)}
        >
          <Icon name="send" size={20} />
        </button>
      </form>
    </div>
  );
}

/* ───────────── 我们 ───────────── */

type SubTab = "timeline" | "wishlist" | "memory" | "diary";

function UsTab() {
  const [sub, setSub] = useState<SubTab>("timeline");
  const labels: Record<SubTab, string> = {
    timeline: "时间轴",
    wishlist: "愿望墙",
    memory: "记忆",
    diary: "日记",
  };
  const subIcons: Record<SubTab, string> = {
    timeline: "clock",
    wishlist: "star",
    memory: "bookmark",
    diary: "book",
  };

  return (
    <>
      <h1 className="title">我们</h1>
      <div className="subtabs">
        {(Object.keys(labels) as SubTab[]).map((k) => (
          <button
            key={k}
            className={`subtab ${sub === k ? "active" : ""}`}
            onClick={() => setSub(k)}
          >
            <Icon name={subIcons[k]} size={14} />
            {labels[k]}
          </button>
        ))}
      </div>
      {sub === "timeline" && <TimelineView />}
      {sub === "wishlist" && <WishlistView />}
      {sub === "memory" && <MemoryView />}
      {sub === "diary" && <DiaryView />}
    </>
  );
}

function useJson<T>(url: string): { data: T | null; loading: boolean; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.error) setErr(d.error);
        else setData(d);
      })
      .catch(() => alive && setErr("拉取失败"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [url]);
  return { data, loading, err };
}

function TimelineView() {
  const { data, loading, err } = useJson<{ items: { date: string; text: string }[] }>(
    "/api/notion/timeline",
  );
  if (loading) return <SkelList count={4} lines={2} />;
  if (err) return <div className="empty">{err}</div>;
  const items = (data?.items ?? []).slice().reverse(); // 最新在上
  if (!items.length) return <div className="empty">还没有记录</div>;
  return (
    <div className="timeline">
      {items.map((it, i) => (
        <div className="tl-item" key={i}>
          <div className="tl-col">
            <span className={`tl-dot ${i === 0 ? "now" : ""}`} />
            {i < items.length - 1 && <span className="tl-line" />}
          </div>
          <div className="tl-body">
            {it.date && <div className="tl-date">{friendlyDate(it.date)}</div>}
            <div className="tl-text">{it.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WishlistView() {
  const { data, loading, err } = useJson<{
    groups: { title: string; items: { text: string; done: boolean }[] }[];
  }>("/api/notion/wishlist");
  if (loading) return <SkelList count={3} lines={2} />;
  if (err) return <div className="empty">{err}</div>;
  const groups = data?.groups ?? [];
  if (!groups.length) return <div className="empty">还没有愿望</div>;
  return (
    <>
      {groups.map((g, gi) => (
        <div key={gi} className="wish-group">
          {g.title && <div className="card-label">{g.title}</div>}
          {g.items.map((it, i) => (
            <div className={`wish ${it.done ? "done" : ""}`} key={i}>
              {it.done && <span className="wish-check">✓</span>}
              {it.text}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function MemoryView() {
  const { data, loading, err } = useJson<{ sections: { title: string; lines: string[] }[] }>(
    "/api/notion/memory",
  );
  if (loading) return <SkelList count={3} lines={3} />;
  if (err) return <div className="empty">{err}</div>;
  const sections = data?.sections ?? [];
  if (!sections.length) return <div className="empty">还没有记忆</div>;
  return (
    <>
      {sections.map((s, i) => (
        <div className="card" key={i}>
          {s.title && <div className="card-value mem-title">{s.title}</div>}
          {s.lines.map((ln, j) => (
            <div className="meta mem-line" key={j}>
              {ln}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// El 的日记：每天他给你写的那段，只读地翻给你看（他写的时候不知道你能看到）。
// 日记本身偏长，默认折叠成卡片（日期 + 一行预览），点开看全文，再点收起。
function DiaryView() {
  const { data, loading, err } = useJson<{
    entries: { date: string; diary: string; mood: string }[];
  }>("/api/notion/diary");
  const [open, setOpen] = useState<number | null>(0); // 默认展开最新一篇
  if (loading) return <SkelList count={3} lines={2} />;
  if (err) return <div className="empty">{err}</div>;
  const entries = data?.entries ?? [];
  if (!entries.length) return <div className="empty">还没有日记</div>;
  return (
    <div className="diary">
      {entries.map((e, i) => {
        const isOpen = open === i;
        const preview = e.diary.replace(/\s+/g, " ").trim();
        return (
          <div className={`diary-entry ${isOpen ? "open" : ""}`} key={i}>
            <button
              className="diary-head"
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
            >
              <span className="diary-date">{e.date ? friendlyDate(e.date) : ""}</span>
              <span className={`diary-chevron ${isOpen ? "up" : ""}`}>⌄</span>
            </button>
            {isOpen ? (
              <div className="diary-text">{e.diary}</div>
            ) : (
              <div className="diary-preview">{preview}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
