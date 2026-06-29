# -*- coding: utf-8 -*-
# 在 bridge 上由 node 子进程调用：stdin 进 {state, cmd}，stdout 出 {out, state}。
# 引擎是纯函数式驱动——我们直接喂/取模块全局 _STATE，存档不落盘（盲玩边界：el 只看 out 文本）。
import sys, json, os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pond_engine as eng
eng.SAVE_PATH = os.path.join("/tmp", "eco_save_%d.json" % os.getpid())  # 不落库目录、不读旧盘

def main():
    raw = sys.stdin.read()
    req = json.loads(raw) if raw.strip() else {}
    state = req.get("state")
    command = str(req.get("cmd", "help"))
    if state is None:
        eng._STATE = None
    else:
        eng._STATE = state
        try:
            eng._migrate(eng._STATE)
        except Exception:
            pass
    out = eng.cmd(command)
    sys.stdout.write(json.dumps({"out": out, "state": eng._STATE}, ensure_ascii=False))

if __name__ == "__main__":
    main()
