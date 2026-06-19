// 你画我猜（el 画 · 你猜）的词库 + 猜词匹配。
// el 是画的那个：服务端从词库挑一个词（对你保密），让 el 画成简笔 SVG，你看着猜。
// 选好画、好认、好猜的具体名词；挑词避开最近画过的。

export const DRAW_WORDS: string[] = [
  "太阳", "月亮", "云", "星星", "彩虹", "雨伞", "房子", "树", "花", "苹果",
  "猫", "狗", "鱼", "鸟", "蝴蝶", "兔子", "船", "汽车", "飞机", "自行车",
  "钥匙", "杯子", "蛋糕", "礼物", "气球", "灯泡", "时钟", "书", "帽子", "鞋",
  "心", "钻石", "音符", "信封", "雪人", "冰淇淋", "棒棒糖", "眼镜", "钟表", "山",
  "桥", "锚", "锤子", "雨滴", "闪电", "锅", "茶壶", "蘑菇", "仙人掌", "贝壳",
];

// 挑一题：避开最近画过的；都画遍了就从全集随机。
export function pickDrawWord(recent: string[] = []): string {
  const fresh = DRAW_WORDS.filter((w) => !recent.includes(w));
  const pool = fresh.length ? fresh : DRAW_WORDS;
  return pool[Math.floor(Math.random() * pool.length)];
}

const norm = (s: string) => (s || "").replace(/[\s,。.!！?？、~～「」""'']/g, "").toLowerCase();

// 猜对了吗：去标点空格后，相等 / 互相包含都算对（"猫咪"含"猫"）。
export function matchGuess(guess: string, word: string): boolean {
  const g = norm(guess);
  const w = norm(word);
  if (!g || !w) return false;
  return g === w || g.includes(w) || w.includes(g);
}
