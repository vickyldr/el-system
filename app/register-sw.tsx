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
    // 平时用 window.innerHeight（独立 PWA 里就是整屏高，稳，刚加载也准）；
    // 只有键盘真的弹起来（可视高度明显变矮）才切到 visualViewport，让输入框不被挡。
    const setH = () => {
      const full = window.innerHeight;
      const vv = window.visualViewport?.height ?? full;
      const h = full - vv > 120 ? vv : full;
      document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
    };
    setH();
    // 刚进 app iOS 会先量小一拍，加载后多测几次抢救回来。
    requestAnimationFrame(setH);
    const timers = [setTimeout(setH, 200), setTimeout(setH, 500)];
    window.addEventListener("load", setH);
    window.addEventListener("pageshow", setH);
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    window.visualViewport?.addEventListener("resize", setH);
    window.visualViewport?.addEventListener("scroll", setH);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener("load", setH);
      window.removeEventListener("pageshow", setH);
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
      window.visualViewport?.removeEventListener("resize", setH);
      window.visualViewport?.removeEventListener("scroll", setH);
    };
  }, []);

  return null;
}
