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

type Weather = { temp: number; desc: string; city: string; note?: string; icon?: string } | null;

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

function NowTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

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

          {status?.song_recommendation &&
            (status.song_url ? (
              <a className="card song song-link" href={status.song_url}>
                <div className="song-icon">▸</div>
                <div>
                  <div className="card-label">我想让你听 · 点开去网易云听 ♫</div>
                  <div className="song-name">{status.song_recommendation}</div>
                  {status?.song_reason && <div className="song-reason">{status.song_reason}</div>}
                </div>
              </a>
            ) : (
              <div className="card song">
                <div className="song-icon">♪</div>
                <div>
                  <div className="card-label">我想让你听</div>
                  <div className="song-name">{status.song_recommendation}</div>
                  {status?.song_reason && <div className="song-reason">{status.song_reason}</div>}
                </div>
              </div>
            ))}

          {status?.weather && (
            <div className="card">
              <div className="card-label">天气 · {status.weather.city}</div>
              <div className="card-value">
                {status.weather.icon ? `${status.weather.icon} ` : ""}
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

      <EatDecider />
    </>
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

  // 唤起美团搜这道菜：用隐藏 iframe 触发协议，绝不动主页面（用链接/window.location 会把 PWA 这页跳白）。
  function openMeituan(kw: string) {
    const url = `imeituan://www.meituan.com/search?q=${encodeURIComponent(kw)}`;
    const ifr = document.createElement("iframe");
    ifr.style.display = "none";
    document.body.appendChild(ifr);
    ifr.src = url;
    setTimeout(() => ifr.remove(), 1500);
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
          <button className="eat-btn eat-go" onClick={() => openMeituan(keyword)}>
            📲 去美团搜「{keyword}」
          </button>
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
  if (state === "on") return <span className="notify-on">🔔 已开</span>;
  return (
    <button className="notify-btn" onClick={enable}>
      🔔 开启通知
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
  const [inCall, setInCall] = useState(false);
  const [callState, setCallState] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const callAudioRef = useRef<HTMLAudioElement | null>(null);
  const acRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const callActive = useRef(false);
  const speakingFlag = useRef(false);
  const hadSpeech = useRef(false);
  const silenceStart = useRef(0);
  const segStart = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stkFileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const didInit = useRef(false);
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
  }, []);

  // ── 打电话（免提连续模式，像 GPT 语音）：点一下进入，我一直听；你说完(静音一会儿)我自动识别→想→用声音回你→再听，循环到你挂断 ──
  const SILENT =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

  async function startCall() {
    try {
      // 在用户手势里"解锁"音频，否则 iOS 不让后面自动出声
      const a = callAudioRef.current || new Audio();
      a.src = SILENT;
      a.play().then(() => a.pause()).catch(() => {});
      callAudioRef.current = a;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true } as MediaTrackConstraints,
      });
      streamRef.current = stream;
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ac: AudioContext = new AC();
      await ac.resume().catch(() => {});
      const an = ac.createAnalyser();
      an.fftSize = 1024;
      ac.createMediaStreamSource(stream).connect(an);
      acRef.current = ac;
      analyserRef.current = an;
      callActive.current = true;
      setInCall(true);
      beginListening();
      vadLoop();
    } catch {
      alert("打电话需要麦克风权限哦");
    }
  }

  function endCall() {
    callActive.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    try {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    } catch {
      /* ignore */
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    acRef.current?.close().catch(() => {});
    acRef.current = null;
    callAudioRef.current?.pause();
    speakingFlag.current = false;
    setInCall(false);
    setCallState("idle");
  }

  // 开一段录音、开始听你说
  function beginListening() {
    const stream = streamRef.current;
    if (!stream || !callActive.current) return;
    chunksRef.current = [];
    hadSpeech.current = false;
    silenceStart.current = 0;
    segStart.current = Date.now();
    const rec = new MediaRecorder(stream);
    recRef.current = rec;
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/mp4" });
      if (hadSpeech.current) void processUtterance(blob);
      else if (callActive.current && !speakingFlag.current) beginListening(); // 没说话就接着听
    };
    rec.start();
    setCallState("listening");
  }

  function endSegment() {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  function micLevel() {
    const an = analyserRef.current;
    if (!an) return 0;
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  // 静音检测循环：你出声→记下；说完静默 ~1.1s→自动收尾发送
  function vadLoop() {
    rafRef.current = requestAnimationFrame(vadLoop);
    if (!callActive.current || speakingFlag.current) return;
    if (recRef.current?.state !== "recording") return;
    const THRESH = 0.025;
    const SILENCE_MS = 1100;
    const MAX_MS = 15000;
    const now = Date.now();
    if (micLevel() > THRESH) {
      hadSpeech.current = true;
      silenceStart.current = 0;
    } else if (hadSpeech.current) {
      if (!silenceStart.current) silenceStart.current = now;
      else if (now - silenceStart.current > SILENCE_MS) return endSegment();
    }
    if (hadSpeech.current && now - segStart.current > MAX_MS) endSegment();
  }

  function resumeAfterTurn() {
    speakingFlag.current = false;
    if (callActive.current) beginListening();
    else setCallState("idle");
  }

  async function processUtterance(blob: Blob) {
    setCallState("thinking");
    try {
      const ext = blob.type.includes("webm") ? "webm" : "m4a";
      const fd = new FormData();
      fd.append("audio", blob, `u.${ext}`);
      const sr = await fetch("/api/stt", { method: "POST", body: fd });
      const sd = await sr.json();
      const said = (sd.text || "").trim();
      if (!said) return resumeAfterTurn(); // 没听清，继续听
      const ts = Date.now();
      setMsgs((m) => [...m, { role: "user", content: said, ts }]);
      const cr = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: said }),
      });
      const cd = await cr.json();
      const reply = cd.reply || cd.error || "……";
      setMsgs((m) => [...m, { role: "assistant", content: reply, image: cd.sticker || undefined, ts: ts + 1 }]);
      const tr = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      const a = callAudioRef.current;
      if (tr.ok && a) {
        const url = URL.createObjectURL(await tr.blob());
        a.src = url;
        speakingFlag.current = true;
        setCallState("speaking");
        a.onended = () => {
          URL.revokeObjectURL(url);
          resumeAfterTurn();
        };
        await a.play().catch(() => resumeAfterTurn());
      } else {
        resumeAfterTurn();
      }
    } catch {
      resumeAfterTurn();
    }
  }

  // 通话时点中间的球：打断我说话、立刻继续听你
  function interruptEl() {
    if (speakingFlag.current && callAudioRef.current) {
      callAudioRef.current.pause();
      resumeAfterTurn();
    }
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

  // 打开「找我」：第一次拿到消息就稳稳停到最底（瞬移，且图片/表情加载完再补几次，别停在中间）。
  useEffect(() => {
    if (!didInit.current && msgs.length) {
      didInit.current = true;
      scrollToBottom(false);
      [120, 350, 700].forEach((t) => setTimeout(() => scrollToBottom(false), t));
    }
  }, [msgs]);

  // 之后有新消息 / 正在回复：只有当你本来就在底部时才跟着往下（在看历史就不打扰你）。
  useEffect(() => {
    if (didInit.current && atBottom) scrollToBottom(true);
  }, [msgs, sending]); // eslint-disable-line react-hooks/exhaustive-deps

  async function post(text: string, image?: string, hint?: string) {
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
        <NotifyButton />
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {ttsOn && sttOn && (
            <button className="clear-btn" onClick={startCall} aria-label="打电话">
              📞 打电话
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
            {callState === "listening" ? "🎙️" : callState === "thinking" ? "💭" : callState === "speaking" ? "🔊" : "🤍"}
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

      <div className="messages" ref={messagesRef} onScroll={() => setAtBottom(isNearBottom())}>
        {msgs.length === 0 && <div className="empty">跟他说点什么</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "user" : "el"}`}>
            <div className="bubble-col">
              {m.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="msg-img"
                  src={m.image}
                  alt=""
                  onLoad={() => atBottom && scrollToBottom(false)}
                />
              )}
              {m.content && <div className="bubble">{m.content}</div>}
              <div className="msg-foot">
                {ttsOn && m.role === "assistant" && m.content && (
                  <button
                    className="speak-btn"
                    onClick={() => speak(m.content, i)}
                    aria-label="听"
                  >
                    {speaking === i ? "🔊…" : "🔈"}
                  </button>
                )}
                {m.ts && <span className="msg-time">{fmtTime(m.ts)}</span>}
              </div>
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

      {!atBottom && msgs.length > 0 && (
        <button className="jump-bottom" onClick={() => scrollToBottom(true)} aria-label="回到最新">
          ↓
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
          {uploading ? "…" : "＋"}
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
          😀
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
  const { data } = useJson<{ reminders: { id: string; date: string; text: string }[] }>(
    "/api/reminders",
  );
  const reminders = data?.reminders ?? [];

  return (
    <>
      <div className="card">
        <div className="card-label">月经周期</div>
        <div className="card-value">{p.title}</div>
        <div className="meta">{p.note}</div>
      </div>

      <div className="card">
        <div className="card-label">提醒</div>
        {reminders.length === 0 ? (
          <div className="meta">还没有提醒。跟我说"提醒我……"，我记下。</div>
        ) : (
          reminders.map((r) => (
            <div className="meta" key={r.id} style={{ marginTop: 6 }}>
              {r.date.slice(5)} · {r.text}
            </div>
          ))
        )}
      </div>
    </>
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
