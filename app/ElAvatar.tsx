"use client";
import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";

export interface ElAvatarHandle {
  setMouth: (v: number) => void; // 0~1，驱动嘴型
}

const ElAvatar = forwardRef<ElAvatarHandle, { emotion?: string }>(
  ({ emotion }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouthRef = useRef(0);
    const vrmRef = useRef<import("@pixiv/three-vrm").VRM | null>(null);
    const rafRef = useRef<number>(0);

    useImperativeHandle(ref, () => ({
      setMouth: (v: number) => {
        mouthRef.current = v;
      },
    }));

    useEffect(() => {
      let cancelled = false;
      const canvas = canvasRef.current;
      if (!canvas) return;

      async function init() {
        const THREE = await import("three");
        const { GLTFLoader } = await import(
          "three/examples/jsm/loaders/GLTFLoader.js"
        );
        const { VRMLoaderPlugin, VRMUtils } = await import("@pixiv/three-vrm");

        const w = canvas!.clientWidth || 320;
        const h = canvas!.clientHeight || 480;

        const renderer = new THREE.WebGLRenderer({
          canvas: canvas!,
          alpha: true,
          antialias: true,
        });
        renderer.setSize(w, h);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(20, w / h, 0.1, 20);
        // 只显示头部：头在 y≈1.5，拉近
        camera.position.set(0, 1.45, 2.2);
        camera.lookAt(0, 1.45, 0);

        const ambient = new THREE.AmbientLight(0xffffff, 1.2);
        scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 1.0);
        dir.position.set(1, 2, 2);
        scene.add(dir);

        const loader = new GLTFLoader();
        loader.register((p) => new VRMLoaderPlugin(p));

        const gltf = await loader.loadAsync("/elvis.vrm");
        if (cancelled) return;
        const vrm = gltf.userData.vrm as import("@pixiv/three-vrm").VRM;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        vrmRef.current = vrm;
        scene.add(vrm.scene);

        // 初始表情
        setEmotion(vrm, emotion);

        let t = 0;
        function tick(dt: number) {
          if (cancelled) return;
          t += dt;
          vrm.update(dt);

          // 呼吸：头部轻微上下
          if (vrm.humanoid) {
            const head = vrm.humanoid.getNormalizedBoneNode("head");
            if (head) head.rotation.z = Math.sin(t * 0.8) * 0.008;
          }

          // 嘴型同步
          const expr = vrm.expressionManager;
          if (expr) {
            const mouth = Math.max(0, Math.min(1, mouthRef.current));
            expr.setValue("aa", mouth * 0.9);
          }

          renderer.render(scene, camera);
        }

        let last = performance.now();
        function loop(now: number) {
          rafRef.current = requestAnimationFrame(loop);
          tick((now - last) / 1000);
          last = now;
        }
        rafRef.current = requestAnimationFrame(loop);
      }

      init().catch(console.error);

      return () => {
        cancelled = true;
        cancelAnimationFrame(rafRef.current);
        vrmRef.current = null;
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 情绪变化时更新表情
    useEffect(() => {
      const vrm = vrmRef.current;
      if (!vrm) return;
      setEmotion(vrm, emotion);
    }, [emotion]);

    return (
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    );
  }
);
ElAvatar.displayName = "ElAvatar";
export default ElAvatar;

// 情绪 → VRM 表情映射
function setEmotion(vrm: import("@pixiv/three-vrm").VRM, emotion?: string) {
  const expr = vrm.expressionManager;
  if (!expr) return;
  const all = ["happy", "sad", "angry", "surprised", "relaxed"];
  all.forEach((e) => expr.setValue(e, 0));
  switch (emotion) {
    case "playful": expr.setValue("happy", 0.6); break;
    case "tender":  expr.setValue("relaxed", 0.5); break;
    case "heavy":   expr.setValue("sad", 0.5); break;
    case "jealous": expr.setValue("angry", 0.3); break;
    case "surprised": expr.setValue("surprised", 0.7); break;
    default: expr.setValue("relaxed", 0.2);
  }
}
