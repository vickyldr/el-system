# el-system

小家 — el 的后端。基于 Next.js（App Router），部署在 Vercel。

## 接口

### `POST /api/chat`

接收 `{ messages, system }`，调用 Claude API 中转站返回回复。

请求体：

```json
{
  "system": "你是 el……（可选）",
  "messages": [
    { "role": "user", "content": "在吗" }
  ]
}
```

返回：

```json
{ "reply": "在的", "stop_reason": "end_turn", "usage": { } }
```

### `GET /api/status`

从 Notion 读取 el 的当前状态（心情、在听什么歌、天气）。

读取 `NOTION_DATABASE_ID` 指向的数据库里**最新编辑的一条记录**，按属性名（中英文都兼容）取值。返回：

```json
{ "mood": "", "song": "", "weather": "", "updatedAt": "2026-06-10T..." }
```

数据库里建这几个属性即可（名字用中文或英文都行）：心情 / Mood、在听什么歌 / Song、天气 / Weather。

## 环境变量

见 [`.env.example`](./.env.example)。本地把它复制成 `.env.local`，Vercel 上在项目设置里配置。

| 变量 | 用途 |
| --- | --- |
| `CLAUDE_API_KEY` | Claude 中转站的 key（`/api/chat`） |
| `CLAUDE_BASE_URL` | Claude 中转站的 base URL，如 `https://jeniya.chat/v1`（`/api/chat`） |
| `NOTION_TOKEN` | Notion 集成 token（`/api/status`） |
| `NOTION_DATABASE_ID` | el 状态数据库的 ID（`/api/status`） |

## 本地开发

```bash
npm install
cp .env.example .env.local   # 填入真实值
npm run dev
```

## 部署

直接把仓库连到 Vercel，配好上面的环境变量即可。
