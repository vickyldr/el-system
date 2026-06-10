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

type Weather = { temp: number; desc: string; city: string } | null;

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

  const now = new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const hasAny =
    status && (status.mood || status.song_recommendation || status.weather || status.el_note);

  return (
    <>
      <div className="topline">{now} · El</div>
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
            <div className="card">
              <div className="card-label">在听什么歌</div>
              <div className="card-value">{status.song_recommendation}</div>
              {status?.song_reason && <div className="meta">{status.song_reason}</div>}
            </div>
          )}

          {status?.weather && (
            <div className="card">
              <div className="card-label">天气 · {status.weather.city}</div>
              <div className="card-value">
                {status.weather.temp}° {status.weather.desc}
              </div>
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
    </>
  );
}

/* ───────────── 找我（聊天） ───────────── */

type Msg = { role: "user" | "assistant"; content: string };

const CHAT_KEY = "el_chat";
const HISTORY_WINDOW = 100; // 每次发给 API 的对话窗口
const STORE_CAP = 1000; // 本地最多存这么多条

function FindTab() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // 开 app 时从本地恢复对话（关了再开还在）。
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CHAT_KEY);
      if (saved) setMsgs(JSON.parse(saved));
    } catch {
      /* ignore */
    }
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
    if (!text || sending) return;

    const history = msgs.slice(-HISTORY_WINDOW);
    setMsgs((m) => [...m, { role: "user", content: text }]);
    setInput("");
    setSending(true);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const d = await r.json();
      setMsgs((m) => [...m, { role: "assistant", content: d.reply || d.error || "……" }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", content: "连不上，等下再说。" }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat">
      <div className="messages">
        {msgs.length === 0 && <div className="empty">跟他说点什么</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "user" : "el"}`}>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {sending && (
          <div className="msg el">
            <div className="bubble muted">…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="说点什么…"
          enterKeyHint="send"
        />
        <button type="submit" aria-label="发送" disabled={sending || !input.trim()}>
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
  return (
    <div className="empty">
      小事（待搭建）
      <br />
      月经周期预测、待办提醒等
    </div>
  );
}
