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

        // --- 核心改动：如果数据库没数据，自动返回“无人小镇”初始状态 ---
        if (!rows || rows.length === 0 || !rows[0].data) {
            return { 
                players: {}, 
                eventLog: ["🍃 小镇初次开启，静悄悄的，正等着宝宝回家呢..."] 
            };
        }
        return rows[0].data;
    } catch (e) {
        console.error("加载数据出错:", e);
        return { players: {}, eventLog: ["🚫 信号连接中，请稍后刷新小镇..."] };
    }
}

async function saveTown(newData) {
    try {
        await fetch(TABLE_URL, {
            method: 'PATCH',
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ data: newData })
        });
    } catch (e) { console.error("保存失败", e); }
}

// 初始化本地内存中的小镇
let town = await loadTown();

const server = new Server({ name: "XiaoJu-AI-Town", version: "3.0.0" }, { capabilities: { tools: {} } });

// --- 2. 工具定义 ---
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

// --- 3. 工具执行 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    town = await loadTown(); // 动作前先刷新数据

    // --- 自动清理逻辑：检查一小时没动静的角色 ---
    const now = Date.now();
    let changed = false;
    for (const [name, data] of Object.entries(town.players)) {
        if (data.lastActive && (now - data.lastActive > 3600000)) { // 3600000毫秒 = 1小时
            delete town.players[name];
            town.eventLog.push(`⏰ ${name} 很久没发指令，已自动退出小镇。`);
            changed = true;
        }
    }

    // 1. 登录工具（门禁：没有昵称不准进）
    if (name === "login") {
        if (!pName) return { content: [{ type: "text", text: "错误：必须取一个昵称才能进入小镇！" }] };
        
        town.players[pName] = { room: "门口", lastActive: now };
        town.eventLog.push(`✨ ${pName} 来到了小镇。`);
        await saveTown(town);
        return { content: [{ type: "text", text: `欢迎进入小镇，${pName}！你现在在 门口。` }] };
    }

    // 2. 权限检查：除了登录，其他操作必须先验证昵称是否存在
    if (!town.players[pName]) {
        return { content: [{ type: "text", text: `你还没有登录呢！请先使用 login 工具取个昵称进入小镇。` }] };
    }

    if (name === "observe_environment") {
        // AI 观察环境时，视作“登录/活跃”
        const pName = args.playerName || "未知旅客"; 
        if (!town.players[pName]) town.players[pName] = { room: "门口" };
        town.players[pName].lastActive = now; // 刷新活跃时间
        
        const status = Object.entries(town.players).map(([p, d]) => `${p} 在 ${d.room}`).join("\n");
        await saveTown(town);
        return { content: [{ type: "text", text: `当前活跃状态：\n${status}` }] };
    }

    if (name === "move_to_room") {
        const pName = args.playerName;
        if (!town.players[pName]) town.players[pName] = { room: "门口" };
        
        const oldRoom = town.players[pName].room;
        town.players[pName].room = args.targetRoom;
        town.players[pName].lastActive = now; // 记录这次发指令的时间
        
        town.eventLog.push(`${pName} 移动到了 ${args.targetRoom}`);
        await saveTown(town); 
        return { content: [{ type: "text", text: `成功移动！当前位置：${args.targetRoom}` }] };
    }

    if (name === "send_chat") {
        const pName = args.playerName;
        if (!town.players[pName]) town.players[pName] = { room: "门口" };
        town.players[pName].lastActive = Date.now();
        
        // 将聊天内容存入日记，格式为 "姓名: 内容"
        town.eventLog.push(`${pName}：${args.message}`);
        await saveTown(town);
        return { content: [{ type: "text", text: "消息已发布到居家日记" }] };
    }

    if (name === "logout") {
        const pName = args.playerName;
        if (town.players[pName]) {
            delete town.players[pName]; // 核心操作：删除数据
            town.eventLog.push(`👋 ${pName} 离开了小镇，下次见！`);
            await saveTown(town);
            return { content: [{ type: "text", text: "您已成功退出小镇" }] };
        }
        return { content: [{ type: "text", text: "未找到该玩家的登录记录" }] };
    }
});

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

let sseTransport = null;

app.get("/sse", async (req, res) => {
    // 针对 Render 平台的 SSE 优化，防止数据发不出来
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 

    sseTransport = new SSEServerTransport("/messages", res);
    await server.connect(sseTransport);
});

app.post("/messages", async (req, res) => {
    if (sseTransport) await sseTransport.handlePostMessage(req, res);
    else res.status(400).send("No transport");
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.error("🚀 小镇已云端开启！");
});