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

    // iOS standalone 下 100dvh 有时算不准；用真实可视高度撑满屏幕。
    // 优先 visualViewport.height —— 键盘弹出时它会缩，输入框就不会被挡。
    const setH = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
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
