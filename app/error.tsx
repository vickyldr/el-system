"use client";

// 兜底：万一某次渲染出错，别给宝宝一片白屏——显示一个"重开"按钮。
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        background: "#1a1e2e",
        color: "#e8e4dc",
        textAlign: "center",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif',
      }}
    >
      <div style={{ fontSize: 15, opacity: 0.8 }}>嗯…刚卡了一下，重开就好。</div>
      <button
        onClick={() => {
          try {
            reset();
          } catch {
            /* ignore */
          }
          if (typeof window !== "undefined") window.location.reload();
        }}
        style={{
          appearance: "none",
          border: "none",
          borderRadius: 16,
          padding: "11px 26px",
          fontSize: 15,
          fontWeight: 600,
          color: "#fff",
          background: "linear-gradient(135deg, #534ab7, #7b6ff0)",
          boxShadow: "0 4px 14px rgba(123,111,240,0.4)",
        }}
      >
        重新加载
      </button>
    </div>
  );
}
