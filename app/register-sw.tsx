"use client";

import { useEffect } from "react";

export default function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // updateViaCache:"none" —— 每次都重新拉 sw.js，别用浏览器缓存的旧 SW
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .then((reg) => {
          reg.update();
          // 发现新版本就让它立刻接管
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing;
            sw?.addEventListener("statechange", () => {
              if (sw.state === "installed" && navigator.serviceWorker.controller) {
                sw.postMessage("skip-waiting");
              }
            });
          });
        })
        .catch(() => {});
    }

    // 高度：平时完全交给 CSS 的 100dvh（独立 PWA 里就是整屏高，启动即正确，不会悬空）。
    // JS 只在键盘弹起时临时顶一下，让输入框露出来；键盘一收就还给 CSS。
    const setH = () => {
      const full = window.innerHeight;
      const vv = window.visualViewport?.height ?? full;
      if (full - vv > 120) {
        document.documentElement.style.setProperty("--app-h", `${Math.round(vv)}px`);
      } else {
        document.documentElement.style.removeProperty("--app-h");
      }
    };
    setH();
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    window.visualViewport?.addEventListener("resize", setH);
    window.visualViewport?.addEventListener("scroll", setH);
    return () => {
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
      window.visualViewport?.removeEventListener("resize", setH);
      window.visualViewport?.removeEventListener("scroll", setH);
    };
  }, []);

  return null;
}
