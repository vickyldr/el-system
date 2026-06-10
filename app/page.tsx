"use client";

import { useEffect, useState } from "react";

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

type Tab = "now" | "find" | "us";

export default function Home() {
  const [tab, setTab] = useState<Tab>("now");

  return (
    <div className="app">
      <div className="content">
        {tab === "now" && <NowTab />}
        {tab === "find" && <Soon title="找我" />}
        {tab === "us" && <Soon title="我们" />}
      </div>
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
    status &&
    (status.mood || status.song_recommendation || status.weather || status.el_note);

  return (
    <>
      <h1 className="title">
        此刻<span className="dot">·</span>
      </h1>

      {loading && <div className="empty">读取中…</div>}

      {!loading && !hasAny && (
        <div className="empty">
          还没接上她的状态～
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

function Soon({ title }: { title: string }) {
  return (
    <>
      <h1 className="title">{title}</h1>
      <div className="empty">（待搭建）</div>
    </>
  );
}
