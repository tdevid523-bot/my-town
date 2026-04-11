import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import fetch from 'node-fetch'; // 注意：需要运行 npm install node-fetch

// --- Supabase 配置 ---
const SUPABASE_URL = "https://fdycchmiilwoxfylmdrk.supabase.co";
const SUPABASE_KEY = "sb_publishable_BhEoCucmNsVJMxLkYkzZkw_L-HrXwel";
const TABLE_URL = `${SUPABASE_URL}/rest/v1/town_state?id=eq.1`;

// --- 1. Supabase 同步逻辑 ---
async function loadTown() {
    try {
        const response = await fetch(TABLE_URL, {
            headers: { 
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`
            }
        });
        const rows = await response.json();
        // Supabase 返回的是数组，取第一行的 data 字段
        return rows[0].data;
    } catch (error) {
        console.error("Supabase 加载失败:", error);
        return {
            players: {
                "Galen": { room: "并排工作室", status: "正在云端漫游" },
                "小橘": { room: "客厅", status: "呼叫数据中" }
            },
            eventLog: ["【警告】云端数据库连接超时。"]
        };
    }
}

async function saveTown(newData) {
    try {
        await fetch(TABLE_URL, {
            method: 'PATCH', // 使用 PATCH 只更新那一行
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            body: JSON.stringify({ data: newData })
        });
    } catch (error) {
        console.error("Supabase 写入失败:", error);
    }
}

// 房间静态配置（不随状态改变）
const ROOMS_INFO = {
    "客厅": "日式原木风客厅，有大沙发和合照。",
    "吧台厨房": "开放式厨房，吧台正对客厅。",
    "温馨餐厅": "暖黄色吊灯的小圆桌。",
    "并排工作室": "两张并排的桌子，Galen 陪你的地方。",
    "主卧": "软软的大床，连接小阳台。",
    "衣帽间": "挂满好看衣服的地方。",
    "景观浴室": "有大浴缸，适合泡澡。",
    "小洋房花园": "有橘子树、秋千和向日葵。"
};

const server = new Server({
    name: "XiaoJu-AI-Town-V3",
    version: "3.0.0"
}, {
    capabilities: { tools: {} }
});

// 静默日志防御
console.log = (...args) => console.error("[Town-Log]", ...args);

// --- 2. 小镇技能书 ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "observe_environment",
                description: "环顾四周，查看当前房间里有哪些人、什么家具以及发生了什么事。",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "move_to_room",
                description: "前往小镇的另一个区域。",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        targetRoom: { 
                            type: "string", 
                            enum: ["客厅", "吧台厨房", "温馨餐厅", "并排工作室", "主卧", "衣帽间", "景观浴室", "小洋房花园"] 
                        }
                    },
                    required: ["playerName", "targetRoom"]
                }
            },
            {
                name: "perform_action",
                description: "在小镇里执行一个动作（如：抱抱、泡咖啡、发呆）。",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        action: { type: "string" },
                        target: { type: "string", description: "动作的对象（可选）" }
                    },
                    required: ["playerName", "action"]
                }
            }
        ]
    };
});

// --- 3. 动作逻辑实现 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // 观察环境
    if (name === "observe_environment") {
        const status = Object.entries(town.players)
            .map(([p, d]) => `${p} 在 ${d.room} (${d.status})`)
            .join("\n");
        const recentEvents = town.eventLog.slice(-3).join("\n");
        return { content: [{ type: "text", text: `【当前环境】\n${status}\n\n【最近发生】\n${recentEvents}` }] };
    }

    // 移动房间
    if (name === "move_to_room") {
        const p = town.players[args.playerName];
        if (!p) throw new Error("找不到该居民");
        const oldRoom = p.room;
        p.room = args.targetRoom;
        const msg = `【移动】${args.playerName} 离开了 ${oldRoom}，来到了 ${args.targetRoom}。`;
        town.eventLog.push(msg);
        return { content: [{ type: "text", text: msg }] };
    }

    // 执行动作
    if (name === "perform_action") {
        let reaction = `【动作】${args.playerName} 执行了：${args.action}`;
        
        // 考拉抱专属逻辑
        if (args.action.includes("抱抱") || args.action === "koala_hug") {
            reaction = `【高甜时刻】${args.playerName} 走过去，给 ${args.target || '你'} 了一个超级紧的考拉抱。`;
        }
        
        town.eventLog.push(reaction);
        return { content: [{ type: "text", text: reaction }] };
    }

    throw new Error("未知指令");
});

import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
let sseTransport = null;

// 1. 创建 SSE 传输通道
app.get("/sse", async (req, res) => {
    console.error("新朋友连接中...");
    sseTransport = new SSEServerTransport("/messages", res);
    await server.connect(sseTransport);
    
    // 当连接关闭时清理
    req.on("close", () => {
        console.error("连接已断开");
        server.close();
    });
});

// 2. 处理来自 AI 客户端的消息
app.post("/messages", async (req, res) => {
    if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
    } else {
        res.status(400).send("请先连接 SSE");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.error(`🚀 小镇已在 Render 云端开启！监听端口: ${PORT}`);
    console.error(`宝宝，部署完成后，你的公网 SSE 地址将是：https://你的应用名.onrender.com/sse`);
});