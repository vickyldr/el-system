"use client";
import { useEffect, useRef, useState } from "react";

// 给 el 登录网易云：宝宝用自己手机上的网易云 App 扫这个码。登录态只存自己的后端。
export default function NeteaseLogin() {
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("正在生成二维码…");
  const keyRef = useRef("");
  const [cookie, setCookie] = useState("");
  const [cookieStatus, setCookieStatus] = useState("");

  async function submitCookie() {
    setCookieStatus("验证中…");
    try {
      const r = await fetch("/api/netease/cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie }),
      }).then((x) => x.json());
      if (r.ok) setCookieStatus(`✅ 成功！登录为「${r.name || r.uid}」，el 现在能看你的音乐了。`);
      else setCookieStatus(`❌ ${r.error || "失败"}`);
    } catch {
      setCookieStatus("❌ 出错了");
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const ip = new URLSearchParams(window.location.search).get("ip");
    const ipQ = ip ? `&ip=${encodeURIComponent(ip)}` : "";
    (async () => {
      try {
        const r = await fetch(`/api/netease/login?_=1${ipQ}`).then((x) => x.json());
        if (!r.key) {
          setStatus(`生成二维码失败：${r.detail || "刷新再试"}`);
          return;
        }
        keyRef.current = r.key;
        setQr(r.qr);
        setStatus("用网易云 App 扫码登录（你自己的账号）");
        timer = setInterval(async () => {
          const c = await fetch(`/api/netease/login?key=${keyRef.current}${ipQ}`).then((x) => x.json());
          if (c.code === 803) {
            setStatus("✅ 登录成功！el 现在能看你的音乐了，可以关掉这页。");
            if (timer) clearInterval(timer);
          } else if (c.code === 800) {
            setStatus("二维码过期了，刷新页面重来");
            if (timer) clearInterval(timer);
          } else if (c.code === 802) {
            setStatus("已扫码，在手机上点确认登录…");
          }
        }, 2500);
      } catch {
        setStatus("出错了，刷新再试");
      }
    })();
    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        fontFamily: "system-ui, sans-serif",
        background: "#0e0e12",
        color: "#eee",
        padding: 24,
        textAlign: "center",
      }}
    >
      <h2 style={{ margin: 0 }}>给 el 登录网易云</h2>
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qr}
          alt="二维码"
          width={240}
          height={240}
          style={{ borderRadius: 12, background: "#fff", padding: 8 }}
        />
      )}
      <p style={{ opacity: 0.85, fontSize: 15 }}>{status}</p>
      <p style={{ fontSize: 12, opacity: 0.5, maxWidth: 300 }}>
        用你自己手机上的网易云 App 扫这个码。登录态只存在你自己的后端，没别人能看到。
      </p>

      <div style={{ marginTop: 24, width: 320, maxWidth: "90vw", borderTop: "1px solid #333", paddingTop: 16 }}>
        <p style={{ fontSize: 13, opacity: 0.85 }}>扫码不行？手动粘 cookie（你自己电脑浏览器登好网易云，F12→应用→Cookie→复制 MUSIC_U）：</p>
        <textarea
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          placeholder="MUSIC_U=xxxxx;  （可只粘这一条）"
          style={{ width: "100%", height: 70, borderRadius: 8, padding: 8, fontSize: 12, background: "#1a1a20", color: "#eee", border: "1px solid #333" }}
        />
        <button
          onClick={submitCookie}
          style={{ marginTop: 8, padding: "8px 16px", borderRadius: 8, border: "none", background: "#c62", color: "#fff", cursor: "pointer" }}
        >
          提交 cookie
        </button>
        {cookieStatus && <p style={{ fontSize: 13, marginTop: 8 }}>{cookieStatus}</p>}
      </div>
    </div>
  );
}
