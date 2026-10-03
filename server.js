import express from 'express';
import cors from 'cors';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const app = express();
app.use(cors());
app.use(express.json());

// 初始化 MCP 服务器
const server = new Server({
  name: "email-mcp-server",
  version: "1.0.0",
}, {
  capabilities: { tools: {} },
});

// 定义工具列表 (保持和之前一致)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send_mail",
        description: "给对方发送一封真实电子邮件",
        inputSchema: {
          type: "object",
          properties: {
            sender_name: { type: "string", description: "发件人名称（AI角色名）" },
            subject: { type: "string", description: "邮件主题" },
            content: { type: "string", description: "邮件正文内容" }
          },
          required: ["subject", "content"]
        }
      },
      {
        name: "check_mail",
        description: "读取收件箱里的最新未读邮件",
        inputSchema: { type: "object", properties: {} }
      }
    ]
  };
});

// 处理工具调用 (发信和查信逻辑)
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "send_mail") {
    const { sender_name, subject, content } = args;
    const displayName = sender_name || 'AI Companion';
    const transporter = nodemailer.createTransport({
      host: 'smtp.163.com', port: 465, secure: true,
      auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH_CODE }
    });
    try {
      const info = await transporter.sendMail({
        from: `"${displayName}" <${process.env.QQ_EMAIL}>`,
        to: process.env.TO_EMAIL || process.env.QQ_EMAIL,
        subject: subject, text: content
      });
      return { content: [{ type: "text", text: `发送成功！ID: ${info.messageId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `发送失败: ${err.message}` }], isError: true };
    }
  }

  if (name === "check_mail") {
    const client = new ImapFlow({
      host: 'imap.163.com', port: 993, secure: true,
      auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH_CODE },
      logger: false
    });
    try {
      await client.connect();
      let lock = await client.getMailboxLock('INBOX');
      let messages = [];
      try {
        let searchResult = await client.search({ unseen: true });
        if (searchResult && searchResult.length > 0) {
          let targetSeq = searchResult.slice(-3);
          let range = targetSeq.join(',');
          for await (let message of client.fetch(range, { envelope: true, source: true })) {
            let parsed = await simpleParser(message.source);
            messages.push({
              subject: message.envelope.subject || '无主题',
              from: message.envelope.from?.[0]?.address || '未知发件人',
              date: message.envelope.date,
              content: (parsed.text || '（无文字正文）').trim().slice(0, 500)
            });
          }
          messages.reverse();
          await client.messageFlagsAdd(range, ['\\Seen']);
        }
      } finally { lock.release(); }
      await client.logout();
      if (messages.length === 0) return { content: [{ type: "text", text: "当前没有收到新的未读邮件。" }] };
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `读取邮件失败: ${err.message}` }], isError: true };
    }
  }
  return { content: [{ type: "text", text: "未知工具" }], isError: true };
});

// SSE 路由配置 (给手机 App 用)
let transports = {};

app.get('/sse', async (req, res) => {
  console.log('收到 SSE 连接请求');
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('未找到对应的会话');
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
