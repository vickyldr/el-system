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

    // iOS standalone 下 100dvh/100% 有时算短，用真实可视高度撑满屏幕。
    const setH = () =>
      document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
    setH();
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    return () => {
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
    };
  }, []);

  return null;
}
