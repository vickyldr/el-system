"use client";

import { CSSProperties, useEffect, useRef } from "react";

// 可复用的 Lottie 播放器：把 AE 导出的动画 JSON 渲染成 SVG。
// el 的表情、心跳、心情动画都走它——比 CSS 精细。
// lottie-web 只在客户端跑（用 lottie_light，svg-only，体积更小），动态 import 避免 SSR。
export default function Lottie({
  src,
  className,
  style,
  loop = true,
  autoplay = true,
  speed = 1,
}: {
  src: string; // public 下的路径，如 /lottie/mood-breath.json
  className?: string;
  style?: CSSProperties;
  loop?: boolean;
  autoplay?: boolean;
  speed?: number; // 心跳快慢——改它不重载动画，只 setSpeed
}) {
  const ref = useRef<HTMLDivElement>(null);
  const animRef = useRef<{ destroy: () => void; setSpeed: (s: number) => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lottie = (await import("lottie-web/build/player/lottie_light")).default;
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = ""; // 重挂前清干净，避免叠加
      const anim = lottie.loadAnimation({
        container: ref.current,
        renderer: "svg",
        loop,
        autoplay,
        path: src,
      });
      anim.setSpeed(speed);
      animRef.current = anim;
    })();
    return () => {
      cancelled = true;
      animRef.current?.destroy();
      animRef.current = null;
    };
    // 只在 src/loop/autoplay 变时重载；speed 单独走下面的 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, loop, autoplay]);

  // 心跳快慢变化时只调 setSpeed，不重载动画（避免闪一下）
  useEffect(() => {
    animRef.current?.setSpeed(speed);
  }, [speed]);

  return <div ref={ref} className={className} style={style} aria-hidden />;
}
