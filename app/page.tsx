export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", lineHeight: 1.6 }}>
      <h1>el-system</h1>
      <p>小家。后端服务正在运行。</p>
      <ul>
        <li>
          <code>POST /api/chat</code> — 接收 <code>{`{ messages, system }`}</code>，调用 Claude 返回回复
        </li>
        <li>
          <code>GET /api/status</code> — 从 Notion 读取 el 的当前状态（心情、在听什么歌、天气）
        </li>
      </ul>
    </main>
  );
}
