"use client";

import { useEffect } from "react";

export default function RegisterSW() {
  useEffect(() => {
    // 异步加载中文字体——绝不阻塞渲染（外链 CSS 会阻塞，CDN 被墙就白屏）。
    // 加载不到就用系统 PingFang，页面照常。霞鹜文楷走国内 BootCDN（稳）。
    const fonts: [string, string][] = [
      ["misans-r", "https://cdn.jsdelivr.net/npm/misans@4.1.0/lib/Normal/MiSans-Regular.min.css"],
      ["misans-sb", "https://cdn.jsdelivr.net/npm/misans@4.1.0/lib/Normal/MiSans-Semibold.min.css"],
      ["lxgw", "https://cdn.bootcdn.net/ajax/libs/lxgw-wenkai-screen-webfont/1.7.0/style.min.css"],
    ];
    fonts.forEach(([key, href]) => {
      if (document.querySelector(`link[data-font="${key}"]`)) return;
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.setAttribute("data-font", key);
      l.media = "print";
      l.onload = () => (l.media = "all"); // 加载好了再应用，全程不挡渲染
      document.head.appendChild(l);
    });

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
