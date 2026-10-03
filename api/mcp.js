import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// 初始化 MCP 服务器
const server = new Server({
  name: "email-mcp-server",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {},
  },
});

// 定义工具列表
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
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // 1. 发信工具
  if (name === "send_mail") {
    const { sender_name, subject, content } = args;
    const displayName = sender_name || 'AI Companion';

    const transporter = nodemailer.createTransport({
      host: 'smtp.163.com', // ⬅️ 163 发信服务器
      port: 465,
      secure: true,
      auth: {
        user: process.env.QQ_EMAIL,       // ⬅️ 你的163邮箱
        pass: process.env.QQ_AUTH_CODE    // ⬅️ 你的163授权码
      }
    });

    try {
      const info = await transporter.sendMail({
        from: `"${displayName}" <${process.env.QQ_EMAIL}>`,
        to: process.env.TO_EMAIL || process.env.QQ_EMAIL,
        subject: subject,
        text: content
      });
      return { content: [{ type: "text", text: `发送成功！Message ID: ${info.messageId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `发送失败: ${err.message}` }], isError: true };
    }
  }

  // 2. 查信工具
  if (name === "check_mail") {
    const client = new ImapFlow({
      host: 'imap.163.com', // ⬅️ 163 收信服务器
      port: 993,
      secure: true,
      auth: {
        user: process.env.QQ_EMAIL,       // ⬅️ 你的163邮箱
        pass: process.env.QQ_AUTH_CODE    // ⬅️ 你的163授权码
      },
      logger: false
    });

    try {
      await client.connect();
      let lock = await client.getMailboxLock('INBOX');
      let messages = [];

      try {
        let searchResult = await client.search({ unseen: true });
        if (searchResult && searchResult.length > 0) {
          let targetSeq = searchResult.slice(-3); // 取最新3封
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
      } finally {
        lock.release();
      }

      await client.logout();

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "当前没有收到新的未读邮件。" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `读取邮件失败: ${err.message}` }], isError: true };
    }
  }

  return { content: [{ type: "text", text: "未知工具" }], isError: true };
});

// Vercel Serverless 入口处理
export default async function handler(req, res) {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // MCP 协议需要通过 SSE (Server-Sent Events) 建立长连接
  // 我们使用官方的 SSEServerTransport
  const transport = new SSEServerTransport("/api/mcp", res);
  await server.connect(transport);
}
