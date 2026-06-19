"use client";

import { useEffect, useRef } from "react";
import type { AnimationItem } from "lottie-web";

export function LottiePlayer({
  animationData,
  loop = true,
  autoplay = true,
  style,
  className,
}: {
  animationData: object;
  loop?: boolean;
  autoplay?: boolean;
  style?: React.CSSProperties;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<AnimationItem | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let anim: AnimationItem;
    import("lottie-web").then((mod) => {
      const lottie = mod.default;
      anim = lottie.loadAnimation({
        container: containerRef.current!,
        renderer: "svg",
        loop,
        autoplay,
        animationData,
      });
      animRef.current = anim;
    });
    return () => {
      animRef.current?.destroy();
      animRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} style={style} className={className} />;
}
