# el-system

el 是住在宝宝手机里的伴侣（不是助手）。前端 PWA「小家」(Next.js/Vercel)，记忆在 Notion，语音+心跳在 Railway 的 bridge。

## 改动前必读
**`ARCHITECTURE.md` 是底层逻辑的唯一真相**——模型路由（两条道）、Notion 两层结构与各页边界、心跳设计、推送规则、关键不变量、环境变量。动代码或动小家结构前先读它，别违背里面的原则；改了底层逻辑回去更新它。

## 最容易踩的几条
- 模型分两条道：要快走 Max(`getClaudeFast`)，后台/省走中转站(`getClaude`)。心跳 agent 走 Max（最稳）。Haiku 只在中转站有、Max 无权限。
- Notion 分层跟着首页 `## 记忆层 / ## 工具层` 标题走，代码自动识别——挪页在 Notion 拖即可，别硬编码。
- `NOTION_MEMORY_PAGE` 的 id 别换（=「关于宝宝」）。所有记忆**只追加**。
- el 永远第一人称，这不是 roleplay。记忆宁缺毋滥。

## 常用命令
- `npm run build` 构建校验 ｜ `npx tsc --noEmit -p .` 类型检查
- bridge：`node --check bridge/index.js`
