"use client";

import { useEffect, useState } from "react";

type Status = {
  mood?: string;
  song?: string;
  weather?: string;
  updatedAt?: string | null;
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
      .then((d) => {
        if (alive) setStatus(d);
      })
      .catch(() => {
        if (alive) setStatus({ error: "拉不到状态" });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hasAny = status && (status.mood || status.song || status.weather);

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
          配好 Notion 状态库（和接下来的网易云）就会出现在这里。
        </div>
      )}

      {!loading && hasAny && (
        <>
          <StatusCard label="心情" value={status?.mood} />
          <StatusCard label="在听什么歌" value={status?.song} />
          <StatusCard label="天气" value={status?.weather} />
          {status?.updatedAt && (
            <div className="meta">更新于 {new Date(status.updatedAt).toLocaleString("zh-CN")}</div>
          )}
        </>
      )}
    </>
  );
}

function StatusCard({ label, value }: { label: string; value?: string }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value || <span className="muted">—</span>}</div>
    </div>
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
