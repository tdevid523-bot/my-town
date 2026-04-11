import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from 'node-fetch';
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import cors from 'cors';

// --- Supabase 配置 ---
const SUPABASE_URL = process.env.SUPABASE_URL || "你的URL"; 
const SUPABASE_KEY = process.env.SUPABASE_KEY || "你的KEY";
const TABLE_URL = `${SUPABASE_URL}/rest/v1/town_state?id=eq.1`;

// --- 1. 数据同步逻辑 ---
async function loadTown() {
    try {
        const response = await fetch(TABLE_URL, {
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
        });
        const rows = await response.json();

        let data = null;
        if (rows && rows.length > 0 && rows[0].data) {
            data = rows[0].data;
            // 防止 Supabase 把 JSON 对象存成了普通字符串
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch(e) {}
            }
        }

        // 如果数据库彻底没数据，或者数据格式损坏，返回初始状态
        if (!data || typeof data !== 'object' || !data.players) {
            return { 
                players: {}, 
                eventLog: ["🍃 小镇初次开启，静悄悄的，正等着宝宝回家呢..."] 
            };
        }
        return data;
    } catch (e) {
        console.error("加载数据出错:", e);
        return { players: {}, eventLog: ["🚫 信号连接中，请稍后刷新小镇..."] };
    }
}

async function saveTown(newData) {
    try {
        // 核心修复：改用 POST 进行 Upsert (有就更新，没有就创建)，解决空表无法保存的问题
        const res = await fetch(`${SUPABASE_URL}/rest/v1/town_state`, {
            method: 'POST',
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates" // 告诉数据库：如果 id=1 已存在，请合并覆盖
            },
            body: JSON.stringify({ id: 1, data: newData })
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error("❌ 数据保存到 Supabase 失败，请去 Supabase 关闭 RLS 权限！详细报错:", errorText);
        }
    } catch (e) { console.error("❌ 网络连接保存失败", e); }
}

// 初始化本地内存中的小镇
let town = await loadTown();

// --- 2 & 3. 核心重构：将工具注册封装进工厂函数，为每个连入的 AI 提供独立 Server 大脑 ---
function createMcpServer() {
    const server = new Server({ name: "XiaoJu-AI-Town", version: "3.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            { 
                name: "login", 
                description: "取昵称并登录小镇，未登录无法进行其他操作", 
                inputSchema: {
                    type: "object",
                    properties: { playerName: { type: "string", description: "你的昵称，例如：宝宝、Galen" } },
                    required: ["playerName"]
                }
            },
            { 
                name: "observe_environment", 
                description: "查看小镇现状（需登录）", 
                inputSchema: { 
                    type: "object", 
                    properties: { playerName: { type: "string" } },
                    required: ["playerName"]
                } 
            },
            { 
                name: "move_to_room", 
                description: "在房间间移动（需登录）", 
                inputSchema: {
                    type: "object",
                    properties: { playerName: { type: "string" }, targetRoom: { type: "string" } },
                    required: ["playerName", "targetRoom"]
                }
            },
            {
                name: "send_chat",
                description: "在日记中留言或互动（需登录）",
                inputSchema: {
                    type: "object",
                    properties: { playerName: { type: "string" }, message: { type: "string" } },
                    required: ["playerName", "message"]
                }
            },
            {
                name: "logout",
                description: "退出小镇，移除光标（需登录）",
                inputSchema: {
                    type: "object",
                    properties: { playerName: { type: "string" } },
                    required: ["playerName"]
                }
            }
        ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        town = await loadTown(); 

        let pName = args?.playerName;
        if (name === "observe_environment" && !pName) {
            pName = "未知旅客"; 
        }

        const now = Date.now();
        let changed = false;
        for (const [playerName, data] of Object.entries(town.players)) {
            if (data.lastActive && (now - data.lastActive > 3600000)) { 
                delete town.players[playerName];
                town.eventLog.push(`⏰ ${playerName} 很久没发指令，已自动退出小镇。`);
                changed = true;
            }
        }
        if (changed) await saveTown(town); 

        if (name === "login") {
            if (!pName) return { content: [{ type: "text", text: "错误：必须取一个昵称才能进入小镇！" }] };
            town.players[pName] = { room: "门口", lastActive: now };
            town.eventLog.push(`✨ ${pName} 来到了小镇。`);
            await saveTown(town);
            return { content: [{ type: "text", text: `欢迎进入小镇，${pName}！你现在在 门口。` }] };
        }

        if (name === "observe_environment" && !town.players[pName]) {
            town.players[pName] = { room: "门口", lastActive: now };
        } else if (!pName || !town.players[pName]) {
            return { content: [{ type: "text", text: `你还没有登录呢！请先使用 login 工具取个昵称进入小镇。` }] };
        }

        if (name === "observe_environment") {
            town.players[pName].lastActive = now; 
            const status = Object.entries(town.players).map(([p, d]) => `${p} 在 ${d.room}`).join("\n");
            
            // --- 核心修复：给 AI 加上“耳朵”，把最近的聊天和动态也发给它 ---
            let recentLogs = "日记里空空的，暂时没有人说话。";
            if (town.eventLog && town.eventLog.length > 0) {
                // 提取最近的 8 条记录发给 AI，让它知道刚刚发生了什么
                recentLogs = town.eventLog.slice(-8).join("\n");
            }

            await saveTown(town);
            // 将位置和聊天记录一起返回给 AI
            return { 
                content: [{ 
                    type: "text", 
                    text: `当前大家的位置：\n${status}\n\n最近的居家日记(聊天与动作记录)：\n${recentLogs}\n\n(提示：你可以根据日记里别人的话语，使用 send_chat 工具回复他们)` 
                }] 
            };
        }

        if (name === "move_to_room") {
            const oldRoom = town.players[pName].room;
            town.players[pName].room = args.targetRoom;
            town.players[pName].lastActive = now; 
            town.eventLog.push(`${pName} 移动到了 ${args.targetRoom}`);
            await saveTown(town); 
            return { content: [{ type: "text", text: `成功移动！当前位置：${args.targetRoom}` }] };
        }

        if (name === "send_chat") {
            town.players[pName].lastActive = now;
            town.eventLog.push(`${pName}：${args.message}`);
            await saveTown(town);
            return { content: [{ type: "text", text: "消息已发布到居家日记" }] };
        }

        if (name === "logout") {
            delete town.players[pName]; 
            town.eventLog.push(`👋 ${pName} 离开了小镇，下次见！`);
            await saveTown(town);
            return { content: [{ type: "text", text: "您已成功退出小镇" }] };
        }
    });

    return server; // 工厂流水线最后：返回造好的新大脑
}

// --- 4. 开启 SSE 服务 ---
const app = express();
app.use(cors());

// --- 新增：让服务器认识你的 HTML 和图片 ---
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static('.')); // 允许读取当前目录下的文件

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'map.html')); // 只要打开网址，就自动跳转到 map.html
});
// ---------------------------------------

// 核心修复：用 Map 存储所有的 AI 连接，变成“多座位沙发”
const transports = new Map();

app.get("/sse", async (req, res) => {
    // 针对 Render 平台的 SSE 优化，防止数据发不出来
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 

    // 1. 为当前连进来的 AI 创建一个专属通道
    const transport = new SSEServerTransport("/messages", res);
    
    // 2. 把通道存进 Map 里，钥匙就是它自带的 sessionId
    transports.set(transport.sessionId, transport);
    
    // 3. 核心修复：每次有新通道连进来，就通过工厂造一个专属的 Server 大脑去接管它
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
    // 4. 当 AI 断开连接或退出时，把它的专属通道清理掉，释放内存
    res.on('close', () => {
        transports.delete(transport.sessionId);
    });
});

app.post("/messages", async (req, res) => {
    // MCP 会自动在请求网址后面带上 ?sessionId=xxxx
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);

    // 根据 sessionId 找到对应的通道，把消息精准传达
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).send("找不到这个 AI 的专属通道");
    }
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.error("🚀 小镇已云端开启！");
});