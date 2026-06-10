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
          每日总结写好、cron 跑起来后就会出现在这里。
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

function FindTab() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, sending]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const history = msgs.slice(-20);
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
      <div className="empty">{labels[sub]}（待搭建）</div>
    </>
  );
}
