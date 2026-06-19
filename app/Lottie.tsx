"use client";

import { useEffect, useRef } from "react";

// 可复用的 Lottie 播放器：把 AE 导出的动画 JSON 渲染成 SVG。
// el 的表情、心跳、心情动画都走它——比 CSS 精细。
// lottie-web 只在客户端跑（用 lottie_light，svg-only，体积更小），动态 import 避免 SSR。
export default function Lottie({
  src,
  className,
  loop = true,
  autoplay = true,
  speed = 1,
}: {
  src: string; // public 下的路径，如 /lottie/mood-breath.json
  className?: string;
  loop?: boolean;
  autoplay?: boolean;
  speed?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let anim: { destroy: () => void; setSpeed: (s: number) => void } | undefined;
    let cancelled = false;
    (async () => {
      const lottie = (await import("lottie-web/build/player/lottie_light")).default;
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = ""; // 重挂前清干净，避免叠加
      anim = lottie.loadAnimation({
        container: ref.current,
        renderer: "svg",
        loop,
        autoplay,
        path: src,
      });
      anim.setSpeed(speed);
    })();
    return () => {
      cancelled = true;
      anim?.destroy();
    };
  }, [src, loop, autoplay, speed]);

  return <div ref={ref} className={className} aria-hidden />;
}
