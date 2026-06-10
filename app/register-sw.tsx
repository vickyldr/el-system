"use client";

import { useEffect } from "react";

export default function RegisterSW() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
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
