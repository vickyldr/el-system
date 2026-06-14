"use client";
import { useEffect, useRef, useState } from "react";

// 给 el 登录网易云：宝宝用自己手机上的网易云 App 扫这个码。登录态只存自己的后端。
export default function NeteaseLogin() {
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("正在生成二维码…");
  const keyRef = useRef("");

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
    </div>
  );
}
