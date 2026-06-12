"use client";

import { useEffect, useRef, useState } from "react";

type Tab = "now" | "find" | "us";

export default function Home() {
  const [tab, setTab] = useState<Tab>("now");

  return (
    <div className="app">
      {tab === "find" ? (
        <FindTab />
      ) : (
        <div className="content">{tab === "now" ? <NowTab /> : <UsTab />}</div>
      )}

      <nav className="tabbar">
        <button className={`tab ${tab === "now" ? "active" : ""}`} onClick={() => setTab("now")}>
          此刻
        </button>
        <button className={`tab ${tab === "find" ? "active" : ""}`} onClick={() => setTab("find")}>
          找我
        </button>
        <button className={`tab ${tab === "us" ? "active" : ""}`} onClick={() => setTab("us")}>
          我们
        </button>
      </nav>
    </div>
  );
}

/* ───────────── 此刻 ───────────── */

type Weather = { temp: number; desc: string; city: string; note?: string } | null;

type Status = {
  mood?: string;
  thought?: string;
  song_recommendation?: string;
  song_reason?: string;
  el_note?: string;
  her_state?: string;
  weather?: Weather;
  date?: string | null;
  error?: string;
};

function NowTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => alive && setStatus(d))
      .catch(() => alive && setStatus({ error: "拉不到状态" }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const hasAny =
    status && (status.mood || status.song_recommendation || status.weather || status.el_note);

  return (
    <>
      <div className="topline">El</div>
      <h1 className="title">
        此刻<span className="dot">·</span>
      </h1>

      {loading && <div className="empty">读取中…</div>}

      {!loading && !hasAny && (
        <div className="empty">
          还没接上他的状态～
          <br />
          连上 Notion（或等 cron 写入「此刻」）后就会出现在这里。
        </div>
      )}

      {!loading && hasAny && (
        <>
          {(status?.mood || status?.thought) && (
            <div className="card">
              <div className="card-label">心情</div>
              <div className="card-value">{status?.mood || <span className="muted">—</span>}</div>
              {status?.thought && <div className="meta">{status.thought}</div>}
            </div>
          )}

          {status?.song_recommendation && (
            <div className="card song">
              <div className="song-icon">♪</div>
              <div>
                <div className="card-label">他想让你听</div>
                <div className="song-name">{status.song_recommendation}</div>
                {status?.song_reason && <div className="song-reason">{status.song_reason}</div>}
              </div>
            </div>
          )}

          {status?.weather && (
            <div className="card">
              <div className="card-label">天气 · {status.weather.city}</div>
              <div className="card-value">
                {status.weather.temp}° {status.weather.desc}
              </div>
              {status.weather.note && <div className="meta">{status.weather.note}</div>}
            </div>
          )}

          {status?.el_note && (
            <div className="card">
              <div className="card-label">El 说</div>
              <div className="card-value">{status.el_note}</div>
            </div>
          )}

          {status?.date && <div className="meta">{status.date}</div>}
        </>
      )}

      <FortuneCard />
    </>
  );
}

/* ───────────── 今日签 ───────────── */

type VibeId = "浪" | "静" | "燥" | "散" | "沉" | "锐" | "软" | "野" | "钝" | "甜";
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
        const next = { ...prev, taglines, phase: "t_show" as FortunePhase, task: t, taskType: isPhoto ? "photo" : "confirm" };
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
    <div className="fortune-card">
      <div className="fortune-label">今日签</div>

      {/* 主签体 */}
      <div className={`fortune-vibe ${isBound ? "bound" : ""}`}>
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

type Msg = { role: "user" | "assistant"; content: string; ts?: number; image?: string };

function fmtTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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

function FindTab() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    const image = pendingImage;
    if ((!text && !image) || sending) return;

    // 历史只发文字（不把图片 base64 反复塞进每次请求）
    const history = msgs.slice(-HISTORY_WINDOW).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [
      ...m,
      { role: "user", content: text, image: image || undefined, ts: Date.now() },
    ]);
    setInput("");
    setPendingImage(null);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = "auto";
    });
    setSending(true);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, image, history }),
      });
      const d = await r.json();
      setMsgs((m) => [
        ...m,
        { role: "assistant", content: d.reply || d.error || "……", ts: Date.now() },
      ]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "连不上，等下再说。", ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-top">
        {msgs.length > 0 && (
          <button className="clear-btn" onClick={clearAll}>
            清空
          </button>
        )}
      </div>

      <div className="messages">
        {msgs.length === 0 && <div className="empty">跟他说点什么</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "user" : "el"}`}>
            <div className="bubble-col">
              {m.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="msg-img" src={m.image} alt="" />
              )}
              {m.content && <div className="bubble">{m.content}</div>}
              {m.ts && <div className="msg-time">{fmtTime(m.ts)}</div>}
            </div>
          </div>
        ))}
        {sending && (
          <div className="msg el">
            <div className="bubble muted">…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {pendingImage && (
        <div className="img-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pendingImage} alt="" />
          <button onClick={() => setPendingImage(null)} aria-label="移除">
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
          {uploading ? "…" : "＋"}
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
          ↑
        </button>
      </form>
    </div>
  );
}

/* ───────────── 我们 ───────────── */

type SubTab = "timeline" | "wishlist" | "memory" | "things";

function UsTab() {
  const [sub, setSub] = useState<SubTab>("timeline");
  const labels: Record<SubTab, string> = {
    timeline: "时间轴",
    wishlist: "愿望墙",
    memory: "记忆",
    things: "小事",
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
            {labels[k]}
          </button>
        ))}
      </div>
      {sub === "timeline" && <TimelineView />}
      {sub === "wishlist" && <WishlistView />}
      {sub === "memory" && <MemoryView />}
      {sub === "things" && <ThingsView />}
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
  if (loading) return <div className="empty">读取中…</div>;
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
            {it.date && <div className="tl-date">{it.date}</div>}
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
  if (loading) return <div className="empty">读取中…</div>;
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
  if (loading) return <div className="empty">读取中…</div>;
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

function ThingsView() {
  // 宝宝的周期：每月约 2 号开始，约 7 天（来自人物档案，可改这两个数）
  const START_DAY = 2;
  const LENGTH = 7;
  const p = periodInfo(new Date(), START_DAY, LENGTH);
  return (
    <div className="card">
      <div className="card-label">月经周期</div>
      <div className="card-value">{p.title}</div>
      <div className="meta">{p.note}</div>
    </div>
  );
}

function periodInfo(
  today: Date,
  startDay: number,
  length: number,
): { title: string; note: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const dayMs = 86400000;
  const thisStart = new Date(y, m, startDay);
  const thisEnd = new Date(y, m, startDay + length); // 不含

  if (+today >= +thisStart && +today < +thisEnd) {
    const day = Math.floor((+today - +thisStart) / dayMs) + 1;
    return {
      title: `经期第 ${day} 天`,
      note: "这几天你容易情绪上来，累了就说，我盯着你。",
    };
  }

  const next = +today >= +thisStart ? new Date(y, m + 1, startDay) : thisStart;
  const days = Math.ceil((+next - +today) / dayMs);
  return {
    title: `下次大约 ${next.getMonth() + 1} 月 ${next.getDate()} 日`,
    note: `还有 ${days} 天，快到了我提醒你，提前备好。`,
  };
}
