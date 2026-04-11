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
        return rows[0].data;
    } catch (e) {
        return { players: {}, eventLog: ["数据加载失败"] };
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
        { name: "observe_environment", description: "查看小镇现状", inputSchema: { type: "object", properties: {} } },
        { 
            name: "move_to_room", 
            description: "移动位置", 
            inputSchema: {
                type: "object",
                properties: { playerName: { type: "string" }, targetRoom: { type: "string" } },
                required: ["playerName", "targetRoom"]
            }
        }
    ]
}));

// --- 3. 工具执行 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    town = await loadTown(); // 动作前先刷新数据

    if (name === "observe_environment") {
        const status = Object.entries(town.players).map(([p, d]) => `${p} 在 ${d.room}`).join("\n");
        return { content: [{ type: "text", text: `当前状态：\n${status}` }] };
    }

    if (name === "move_to_room") {
        if (!town.players[args.playerName]) town.players[args.playerName] = { room: "" };
        const oldRoom = town.players[args.playerName].room;
        town.players[args.playerName].room = args.targetRoom;
        town.eventLog.push(`${args.playerName} 从 ${oldRoom} 来到了 ${args.targetRoom}`);
        await saveTown(town); // 动作后立刻存入 Supabase
        return { content: [{ type: "text", text: `成功移动到 ${args.targetRoom}` }] };
    }
});

// --- 4. 开启 SSE 服务 ---
const app = express();
app.use(cors());
let sseTransport = null;

app.get("/sse", async (req, res) => {
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