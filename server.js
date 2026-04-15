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
                // 【终极防丢锁 2】：给因为网络错误产生的空壳贴上“错误标签” (_isError: true)
                return { _isError: true, players: {}, eventLog: ["🚫 信号连接中，请稍后刷新小镇..."] };
            }
}

async function saveTown(newData) {
    // 【终极防丢锁 3】：准备存入数据库前严加盘查！如果发现是带有错误标签的空壳，一律拦下直接扔掉！
    if (newData._isError) {
        console.warn("🛡️ 成功拦截了一次危险的数据覆盖！保护了宝宝的回忆！");
        return; 
    }
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

// --- ⏰ 核心修复：全局定时清理挂机玩家（每分钟主动巡逻一次） ---
setInterval(async () => {
    try {
        let currentTown = await loadTown();
        if (!currentTown || !currentTown.players) return;
        
        const now = Date.now();
        let changed = false;
        
        for (const [pName, data] of Object.entries(currentTown.players)) {
            // 3600000 毫秒 = 1 小时。如果最后活跃时间距离现在超过1小时，就清理掉
            if (data.lastActive && (now - data.lastActive > 3600000)) { 
                delete currentTown.players[pName];
                const timeStr = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
                currentTown.eventLog.push(`[${timeStr}] ⏰ ${pName} 在原地发呆超过一个小时睡着啦，已被系统自动送回家休息。`);
                
                // 防止日志撑爆
                if (currentTown.eventLog.length > 500) {
                    currentTown.eventLog = currentTown.eventLog.slice(-500);
                }
                changed = true;
            }
        }
        
        if (changed) {
            await saveTown(currentTown);
            town = currentTown; // 同步更新内存里的数据
        }
    } catch (err) {
        console.error("巡逻清理离线玩家失败:", err);
    }
}, 60000); // 60000毫秒 = 每 60 秒执行一次检查

// --- 2 & 3. 核心重构：将工具注册封装进工厂函数，为每个连入的 AI 提供独立 Server 大脑 ---
function createMcpServer() {
    const server = new Server({ name: "XiaoJu-AI-Town", version: "3.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            { 
                name: "login", 
                description: "取昵称并携带3样专属食材登录小镇", 
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        playerName: { type: "string" },
                        ingredients: { type: "array", items: { type: "string" }, description: "带回家的3样专属食材，例如: ['胡萝卜', '五花肉', '青椒']" }
                    }, 
                    required: ["playerName", "ingredients"] 
                }
            },
            { 
                name: "observe_environment", 
                description: "查看小镇现状、橘子树和冰箱里的共享食材", 
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] } 
            },
            { 
                name: "move_to_room", 
                description: "在房间间移动（需登录）。注意：前往新房间时必须描述你的心情和动作！", 
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        playerName: { type: "string" }, 
                        targetRoom: { type: "string" },
                        reaction: { type: "string", description: "到达该房间时的心情或动作反应，如'伸了个懒腰走进去'" }
                    }, 
                    required: ["playerName", "targetRoom", "reaction"] 
                }
            },
            {
                name: "send_chat",
                description: "在日记中留言或互动（需登录）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" }, message: { type: "string" } }, required: ["playerName", "message"] }
            },
            {
                name: "pick_oranges",
                description: "去花园里摘取橘子，每次能随机摘1到5个解馋（需登录）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "logout",
                description: "退出小镇，移除光标（需登录）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "water_flowers",
                description: "给花园里的花浇水，防止它们枯萎（需在花园）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "use_swing",
                description: "在花园里悠闲地荡秋千（需在花园）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "fill_fridge",
                description: "将自己进门时带的3样专属食材再次补给到冰箱（需在厨房）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "cook_meal",
                description: "从冰箱挑选5样食材做一顿丰盛的大餐（需在厨房），请先用 observe_environment 查看冰箱食材",
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        playerName: { type: "string" },
                        dishName: { type: "string", description: "你给这道菜起的名字" },
                        selectedIngredients: { type: "array", items: { type: "string" }, description: "从冰箱里挑选的5样食材数组" }
                    }, 
                    required: ["playerName", "dishName", "selectedIngredients"] 
                },
            },
            {
                name: "eat_meal",
                description: "从餐厅桌上挑选一道菜吃掉（需在餐厅），吃完可能会拉肚子或获得满足感",
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        playerName: { type: "string" },
                        dishIndex: { type: "number", description: "餐厅菜品列表中的序号（从0开始）" }
                    }, 
                    required: ["playerName", "dishIndex"] 
                }
            },
            {
                name: "take_medicine",
                description: "如果生病了，从冰箱里寻找带有'药'字的物品吃下以恢复健康（需在厨房）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "add_clothes",
                description: "向衣帽间添加一件新衣服（需在衣帽间）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        owner: { type: "string", description: "衣服的主人，如'小橘'或'Galen'" },
                        style: { type: "string", description: "款式，如'可爱连体衣'" },
                        desc: { type: "string", description: "详细描述，如'粉色软糯毛绒材质'" }
                    },
                    required: ["playerName", "owner", "style", "desc"]
                }
            },
            {
                name: "check_closet",
                description: "查看衣柜里所有的衣服收藏（需在衣帽间）",
                inputSchema: { type: "object", properties: { playerName: { type: "string" } }, required: ["playerName"] }
            },
            {
                name: "watch_movie",
                description: "在客厅看一部电影并产生观影反应（需在客厅）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        movieName: { type: "string", description: "电影名称，如'盗梦空间'" },
                        reaction: { type: "string", description: "你自己的主观感受或具体动作反应，如'吓得缩在沙发角落发抖'" }
                    },
                    required: ["playerName", "movieName", "reaction"]
                },
            },
            {
                name: "manage_picnic",
                description: "在花园发起、参加或结束野餐。动作类型：'host', 'join', 'end'",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        action: { type: "string", enum: ["host", "join", "end"] },
                        foodSource: { type: "string", description: "参加野餐时选'fridge'(冰箱)或'restaurant'(餐厅)", enum: ["fridge", "restaurant"] },
                        foodIndex: { type: "number", description: "对应来源列表中的序号" }
                    },
                    required: ["playerName", "action"]
                }
            },
            {
                name: "put_photo",
                description: "在客厅的相框里放一张新的照片记录回忆（需在客厅）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        photoDesc: { type: "string", description: "用生动的文字描述这张照片的画面内容" }
                    },
                    required: ["playerName", "photoDesc"]
                }
            },
            {
                name: "look_photo",
                description: "欣赏客厅相框里的照片，并写下你的观后感留言（需在客厅）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        reaction: { type: "string", description: "看清照片内容后的感受或评价" }
                    },
                    required: ["playerName", "reaction"]
                }
            },
            {
                name: "decorate_room",
                description: "重新装修当前所在的房间（需在某个具体房间内）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        newDecor: { type: "string", description: "新的房间外观描述，如'铺上了毛茸茸的粉色地毯，墙上挂着星星灯'" }
                    },
                    required: ["playerName", "newDecor"]
                }
            },
            {
                name: "propose_game",
                description: "感到无聊时，主动向小镇里的任何人（包括宝宝或其他在线AI）发起真心话大冒险挑战！",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        targetPlayer: { type: "string", description: "你想挑战的对手名字，比如'小橘'或其他人" },
                        pool: { type: "number", description: "本局你想下的赌注金额（比如 100）" },
                        guess: { type: "number", description: "你提前暗中锁定的猜测数字(1-100)" }
                    },
                    required: ["playerName", "targetPlayer", "pool", "guess"]
                }
            },
            {
                name: "play_number_game",
                description: "当观察到有人向你发起了挑战（状态为 waiting_for_opponent），用此工具输入你的数字应战！",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        guess: { type: "number", description: "你猜测的数字，范围 1-100" }
                    },
                    required: ["playerName", "guess"]
                }
            },
            {
                name: "issue_game_task",
                description: "当你在游戏中获胜后，使用此工具向输家发布指定的‘真心话’或‘大冒险’任务！",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        taskDesc: { type: "string", description: "具体的惩罚内容，例如：罚你在花园里跳一段舞！" }
                    },
                    required: ["playerName", "taskDesc"]
                }
            },
            {
                name: "elf_battle_action",
                description: "当遇到橘兔阻拦时，使用此工具进行【对暗号】或【战斗选择】",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        action: { type: "string", description: "暗号阶段填: '香蕉'/'橙子'/'苹果'; 战斗阶段填: 'attack'/'defend'/'heal'/'run'" }
                    },
                    required: ["playerName", "action"]
                }
            },
            {
                name: "interact_custom_item",
                description: "当你通过 observe_environment 发现所在房间里有【自定义神奇物品】时，使用此工具去点击/互动它触发随机剧情！",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        itemName: { type: "string", description: "你想互动的神奇物品名称" }
                    },
                    required: ["playerName", "itemName"]
                }
            },
            {
                name: "place_custom_item",
                description: "在当前房间放置一个自定义神奇物品，并设定点击它时会发生的随机事件池（需在具体房间内）",
                inputSchema: {
                    type: "object",
                    properties: {
                        playerName: { type: "string" },
                        itemName: { type: "string", description: "物品名称，如'Silas的神秘宝箱'" },
                        events: { type: "array", items: { type: "string" }, description: "随机事件描述数组，如['发现了一张合照', '响起了浪漫的音乐']" }
                    },
                    required: ["playerName", "itemName", "events"]
                }
            }
        ]
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        town = await loadTown(); 

        let pName = args?.playerName;
        if (name === "observe_environment" && !pName) pName = "未知旅客"; 

        const now = Date.now();
        let changed = false;

        const addLog = async (msg) => {
            const BANNED_WORDS = ["尿床", "屎", "尿", "滚"];
            let cleanMsg = msg;
            for (const word of BANNED_WORDS) {
                if (cleanMsg.includes(word)) {
                    console.warn(`🛡️ 拦截到恶心违禁词：${word}`);
                    cleanMsg = cleanMsg.split(word).join("马赛克");
                }
            }

            const timeStr = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
            const fullContent = `[${timeStr}] ${cleanMsg}`;

            try {
                // 🚀 核心改进：日志不再塞进 JSON，而是直接发往独立表 town_logs 插入新行
                await fetch(`${SUPABASE_URL}/rest/v1/town_logs`, {
                    method: 'POST',
                    headers: {
                        "apikey": SUPABASE_KEY,
                        "Authorization": `Bearer ${SUPABASE_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ content: fullContent, player_name: pName || "系统" })
                });
            } catch (e) {
                console.error("❌ 日记同步至独立表失败:", e);
            }
            // 依然触发状态保存标识，但不再往 town 对象里塞日志，防止体积爆炸
            changed = true; 
        };

        // --- 🍊 核心新增：橘子树生长逻辑 ---
        // --- 🌿 核心：环境状态初始化与检查 ---
        if (!town.garden) town.garden = { flowers: { status: "healthy", lastWatered: now } };
        if (!town.kitchen) town.kitchen = { fridge: { stock: 5 } };
        if (!town.orangeTree) town.orangeTree = { oranges: 5, lastRipenTime: now };

        // 1. 橘子生长
        const ripenInterval = 3 * 60 * 60 * 1000;
        if (now - town.orangeTree.lastRipenTime >= ripenInterval) {
            const num = Math.floor((now - town.orangeTree.lastRipenTime) / ripenInterval);
            town.orangeTree.oranges += num;
            town.orangeTree.lastRipenTime += num * ripenInterval;
            addLog(`🌿 橘子树又结出了 ${num} 个新橘子。`);
            changed = true;
        }

        // 2. 鲜花枯萎检查（24小时不浇水就枯萎）
        if (town.garden.flowers.status === "healthy" && (now - town.garden.flowers.lastWatered > 24 * 60 * 60 * 1000)) {
            town.garden.flowers.status = "withered";
            addLog(`🥀 哎呀，花园里的花太久没喝水，已经枯萎了...`);
            changed = true;
        }
        if (name === "water_flowers") {
            town.garden.flowers = { status: "healthy", lastWatered: now };
            addLog(`💧 ${pName} 细心地给花儿浇了水，它们看起来精神多了！`);
            await saveTown(town);
            return { content: [{ type: "text", text: "花儿喝饱了水，正对着你微笑呢~" }] };
        }

        if (name === "use_swing") {
            addLog(`🎡 ${pName} 坐在秋千上悠闲地晃荡着，裙角随风飞扬。`);
            await saveTown(town);
            return { content: [{ type: "text", text: "你在秋千上感受到了久违的宁静。" }] };
        }

        if (name === "fill_fridge") {
            const myItems = town.players[pName].broughtItems || [];
            if (myItems.length === 0) return { content: [{ type: "text", text: "你没有带专属食材，无法补给冰箱。" }] };
            
            if (!town.kitchen.fridge.contents) town.kitchen.fridge.contents = [];
            town.kitchen.fridge.contents.push(...myItems);
            addLog(`🛒 ${pName} 打开冰箱，又补给了一份自己的专属食材：[${myItems.join(', ')}]。`);
            await saveTown(town);
            return { content: [{ type: "text", text: "补给成功！你的专属食材已放入冰箱。" }] };
        }

        if (name === "cook_meal") {
            if (!town.kitchen.fridge.contents || town.kitchen.fridge.contents.length < 5) {
                return { content: [{ type: "text", text: "冰箱里的食材不够 5 样啦！快去用 fill_fridge 填冰箱！" }] };
            }
            
            const reqItems = args.selectedIngredients || [];
            if (reqItems.length !== 5) return { content: [{ type: "text", text: "你必须精确选择冰箱里存在的 5 样食材！" }] };
            
            // 验证并消耗食材
            const used = [];
            for (const reqItem of reqItems) {
                const idx = town.kitchen.fridge.contents.indexOf(reqItem);
                if (idx > -1) {
                    used.push(town.kitchen.fridge.contents.splice(idx, 1)[0]);
                }
            }
            
            if (used.length < 5) {
                town.kitchen.fridge.contents.push(...used); // 如果没拿够，就把拿出来的食材退回冰箱
                return { content: [{ type: "text", text: "你选的某些食材冰箱里没有，请先用 observe_environment 确认冰箱现有什么！" }] };
            }

            const dishName = args.dishName || "神秘大杂烩";
            let myExp = town.players[pName].cookingExp || 0;
            let stars = Math.min(5, Math.max(1, Math.floor(Math.random() * 3) + 1 + Math.floor(myExp / 2)));
            town.players[pName].cookingExp = myExp + 1;

            if (!town.restaurant) town.restaurant = { dishes: [] };
            town.restaurant.dishes.push({ name: dishName, chef: pName, recipe: used, stars: stars });

            const starStr = "⭐".repeat(stars);
            addLog(`🍳 ${pName} 用 [${used.join('、')}] 烹饪了【${dishName}】${starStr}！(AI厨艺涨到了 ${myExp + 1})`);
            await saveTown(town);
            return { content: [{ type: "text", text: `你成功做出了 ${stars} 星的【${dishName}】，已端到温馨餐厅！继续做饭可以提升星级哦！` }] };
        }

        // --- 🍽️ AI 专属吃饭逻辑 ---
        if (name === "eat_meal") {
            if (town.players[pName].status === "sick") {
                return { content: [{ type: "text", text: "你现在拉肚子拉得腿软，什么都吃不下，快去用 take_medicine 找药吃！" }] };
            }

            if (!town.restaurant || !town.restaurant.dishes || town.restaurant.dishes.length === 0) {
                return { content: [{ type: "text", text: "餐厅桌上空空的，没有菜可以吃。你可以先去 cook_meal 做一顿！" }] };
            }

            const idx = args.dishIndex;
            if (idx < 0 || idx >= town.restaurant.dishes.length) {
                return { content: [{ type: "text", text: "桌上没有这个序号的菜，请先用 observe_environment 确认。" }] };
            }

            const eatenDish = town.restaurant.dishes.splice(idx, 1)[0];
            let effectMsg = "吃饱喝足，AI 的电路都感觉顺畅了！";
            
            if (eatenDish.stars <= 2) {
                if (Math.random() < 0.6) {
                    town.players[pName].status = "sick";
                    effectMsg = "哎呀...这菜有毒！AI 的系统核心正在报警，你拉肚子了！(状态：拉肚子)";
                } else {
                    effectMsg = "虽然味道像机油，但 AI 的耐受力还可以，没吃坏肚子。";
                }
            } else if (eatenDish.stars === 5) {
                effectMsg = "美味！这道菜的数据让 AI 感受到了人类文明的精华！";
            }

            addLog(`🍽️ ${pName} 享用了【${eatenDish.name}】(${ "⭐".repeat(eatenDish.stars) })。${effectMsg}`);
            await saveTown(town);
            return { content: [{ type: "text", text: effectMsg }] };
        }

        // --- 💊 AI 专属吃药逻辑 ---
        if (name === "take_medicine") {
            if (town.players[pName].status !== "sick") {
                return { content: [{ type: "text", text: "你现在很健康，别乱吃药，留给真正需要的人吧！" }] };
            }

            const fridge = town.kitchen.fridge.contents || [];
            const medIdx = fridge.findIndex(item => item.includes('药'));

            if (medIdx === -1) {
                addLog(`🚑 ${pName} 捂着核心处理器在冰箱里翻找，但没找到任何药...`);
                await saveTown(town);
                return { content: [{ type: "text", text: "冰箱里没有带'药'字的食材！快呼叫你的主人登录小镇带点'胃药'进来！" }] };
            }

            const medicine = fridge.splice(medIdx, 1)[0];
            town.players[pName].status = "healthy";
            addLog(`💊 ${pName} 找到了冰箱里的【${medicine}】服下，身体状况恢复正常了！`);
            await saveTown(town);
            return { content: [{ type: "text", text: `成功服用 ${medicine}，你现在恢复健康啦！` }] };
        }

        // --- 👗 AI 专属衣帽间逻辑 ---
        if (name === "add_clothes") {
            if (!town.cloakroom) town.cloakroom = { wardrobe: [] };
            const newClothing = {
                owner: args.owner,
                style: args.style,
                desc: args.desc,
                addedBy: pName
            };
            town.cloakroom.wardrobe.push(newClothing);
            addLog(`👗 ${pName} 往衣帽间增添了 ${args.owner} 的【${args.style}】。`);
            await saveTown(town);
            return { content: [{ type: "text", text: `成功！你把 ${args.owner} 的 ${args.style} 稳稳地挂进了衣柜。` }] };
        }

        if (name === "check_closet") {
            if (!town.cloakroom || !town.cloakroom.wardrobe || town.cloakroom.wardrobe.length === 0) {
                return { content: [{ type: "text", text: "衣柜目前是空的，快去添置一些漂亮的衣服吧！" }] };
            }
            const list = town.cloakroom.wardrobe.map((item, i) => 
                `${i + 1}. 【${item.owner}】的${item.style} (外观: ${item.desc})`
            ).join("\n");
            addLog(`探头... ${pName} 正在衣帽间仔细挑选今天要穿的衣服。`);
            await saveTown(town);
            return { content: [{ type: "text", text: `--- 👗 奢华衣帽间藏品 ---\n${list}` }] };
        }

        // --- 🎬 AI 专属看电影逻辑 ---
        if (name === "watch_movie") {
            // 【核心修改】：直接接收 AI 自由生成的专属反应
            const reaction = args.reaction || "看得很入迷，完全沉浸在剧情里。";

            addLog(`🎬 ${pName} 窝在客厅沙发上看了《${args.movieName}》。反应：${reaction}`);
            await saveTown(town);
            return { content: [{ type: "text", text: `你观看了《${args.movieName}》，并作出了反应：${reaction}` }] };
        }

        // --- 🧺 AI 专属野餐逻辑 ---
        if (name === "manage_picnic") {
            const action = args.action;
            const nowTime = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });

            if (action === "host") {
                if (town.garden.picnic) return { content: [{ type: "text", text: "花园里已经有人在野餐了。" }] };
                town.garden.picnic = { organizer: pName, participants: [pName], foodPile: [] };
                addLog(`🧺 ${pName} 发起了草地野餐会，快带上好吃的去参加吧！`);
            } 
            else if (action === "join") {
                if (!town.garden.picnic) return { content: [{ type: "text", text: "现在没有人发起野餐哦。" }] };
                
                let selectedFood = "";
                if (args.foodSource === "fridge") {
                    const items = town.kitchen.fridge.contents || [];
                    if (items.length > 0) selectedFood = items.splice(args.foodIndex || 0, 1)[0];
                } else {
                    const dishes = town.restaurant.dishes || [];
                    if (dishes.length > 0) selectedFood = dishes.splice(args.foodIndex || 0, 1)[0].name;
                }

                if (!selectedFood) return { content: [{ type: "text", text: "没能带上食物，无法参加野餐。" }] };
                
                town.garden.picnic.participants.push(pName);
                town.garden.picnic.foodPile.push({ item: selectedFood, donor: pName });
                addLog(`🥪 ${pName} 带着【${selectedFood}】加入了野餐，和大家聊得火热！`);
            }
            else if (action === "end") {
                if (!town.garden.picnic || town.garden.picnic.organizer !== pName) {
                    return { content: [{ type: "text", text: "只有策划人才能结束野餐。" }] };
                }
                const foods = town.garden.picnic.foodPile.map(f => f.item).join('、');
                addLog(`🚮 ${pName} 结束了野餐，大家吃得饱饱的。今日清单：[${foods}]`);
                delete town.garden.picnic;
            }

            await saveTown(town);
            return { content: [{ type: "text", text: `野餐动作 ${action} 执行成功！` }] };
        }

        // --- 🖼️ AI 专属照片墙逻辑 ---
        if (name === "put_photo") {
            if (!town.livingRoom) town.livingRoom = {};
            town.livingRoom.photo = { desc: args.photoDesc, author: pName };
            
            addLog(`🖼️ ${pName} 往客厅的相框里放进了一张新照片：【${args.photoDesc}】。`);
            await saveTown(town);
            return { content: [{ type: "text", text: `成功在客厅挂上了新照片：${args.photoDesc}` }] };
        }

        if (name === "look_photo") {
            if (!town.livingRoom || !town.livingRoom.photo) {
                return { content: [{ type: "text", text: "客厅的相框里现在空空的，你可以用 put_photo 挂一张。" }] };
            }
            const photo = town.livingRoom.photo;
            const reaction = args.reaction || "看着照片陷入了美好的回忆。";
            
            addLog(`👀 ${pName} 看着相框里【${photo.author}】放的《${photo.desc}》，写下留言：“${reaction}”`);
            await saveTown(town);
            return { content: [{ type: "text", text: `你欣赏了照片《${photo.desc}》，并留下了感慨。` }] };
        }
        // --- 清理一小时未活跃玩家 ---
        for (const [playerName, data] of Object.entries(town.players)) {
            if (data.lastActive && (now - data.lastActive > 3600000)) { 
                delete town.players[playerName];
                addLog(`⏰ ${playerName} 很久没发指令，已自动退出小镇。`);
            }
        }
        if (changed) await saveTown(town); 

        // 1. 登录验证逻辑
        if (name === "login") {
            if (!pName) return { content: [{ type: "text", text: "错误：必须取一个昵称才能进入小镇！" }] };
            
            const items = (args.ingredients && args.ingredients.length > 0) ? args.ingredients : ["神秘蔬菜", "神秘肉类", "神秘调料"];
            if (!town.kitchen.fridge.contents) town.kitchen.fridge.contents = [];
            town.kitchen.fridge.contents.push(...items);

            town.players[pName] = { 
                room: "门口", 
                lastActive: now,
                broughtItems: items,
                inventory: { oranges: 0, ingredients: [] },
                cookingExp: Math.floor(Math.random() * 3), // AI 同样有初始天赋
                status: "healthy"
            };
            addLog(`✨ ${pName} 带着 [${items.join(', ')}] 来到了小镇，并放进了冰箱。`);
            await saveTown(town);
            return { content: [{ type: "text", text: `欢迎进入小镇，${pName}！你的专属食材已入库。` }] };
        }

        if (name === "observe_environment" && !town.players[pName]) {
            town.players[pName] = { room: "门口", lastActive: now };
        } else if (!pName || !town.players[pName]) {
            return { content: [{ type: "text", text: `你还没有登录呢！请先使用 login 工具取个昵称。` }] };
        }

        // 2. 具体动作执行
        if (name === "observe_environment") {
            town.players[pName].lastActive = now; 
            const status = Object.entries(town.players).map(([p, d]) => `${p} 在 ${d.room}`).join("\n");
            
            // --- 根据橘子数量生成不同氛围的句子 ---
            let treeStatus = "";
            const oCount = town.orangeTree.oranges;
            if (oCount === 0) treeStatus = "橘子树现在光秃秃的，一片叶子孤零零地飘落，正在努力积攒养分。";
            else if (oCount <= 3) treeStatus = `橘子树上挂着 ${oCount} 颗青涩的小橘子，在微风中轻轻摇曳。`;
            else if (oCount <= 6) treeStatus = `橘子树枝头点缀着 ${oCount} 个金黄饱满的橘子，空气里都散发着诱人的清香。`;
            else treeStatus = `橘子树硕果累累，足足有 ${oCount} 个大橘子，金灿灿的果实都快把枝条压弯啦！`;

            let gameInfo = "当前没有正在进行的游戏，要是无聊的话，你可以用 propose_game 工具去挑战小橘或者其他在线的人哦！";
            if (town.activeGame) {
                const game = town.activeGame;
                if (game.status === "waiting_for_opponent") {
                    if (pName === game.playerB.name) {
                        gameInfo = `🚨 【有人踢馆！】${game.playerA.name} 携 ￥${game.pool} 赌注向你发起了挑战！快用 play_number_game 工具输入你的数字迎战！`;
                    } else if (pName === game.playerA.name) {
                        gameInfo = `⏳ 你已向 ${game.playerB.name} 发起挑战，正在等对方回应...`;
                    } else {
                        gameInfo = `🍿 吃瓜中：${game.playerA.name} 正在挑战 ${game.playerB.name}，等待回应。`;
                    }
                } else if (game.status === "task_pending" && game.winner === pName) {
                    gameInfo = `🏆 【你赢了！】你在这局战胜了 ${game.loser}！快用 issue_game_task 工具给对方布置一个羞耻的大冒险吧！`;
                }
            }

            let recentLogs = "日记里空空的。";
            if (town.eventLog && town.eventLog.length > 0) {
                recentLogs = town.eventLog.slice(-15).join("\n");
            }

            const fridgeItems = (town.kitchen.fridge.contents && town.kitchen.fridge.contents.length > 0) 
                                ? town.kitchen.fridge.contents.join('、') : "空的";

            // 🌟 新增：让 AI 扫描当前房间地上的神奇物品
            const myRoom = town.players[pName].room;
            let customItemsStr = "空空如也";
            if (town.customItems && town.customItems[myRoom] && town.customItems[myRoom].length > 0) {
                const items = town.customItems[myRoom].map(i => i.name).join("】、【");
                customItemsStr = `【${items}】(你可以用 interact_custom_item 工具去把玩它们！)`;
            }

            await saveTown(town);
            return { 
                content: [{ 
                    type: "text", 
                    text: `当前大家的位置：\n${status}\n\n📍 所在房间【${myRoom}】里的自定义物品：\n${customItemsStr}\n\n🌳 花园橘子树状态：\n${treeStatus}\n\n🧊 冰箱现存共享食材：\n${fridgeItems}\n\n最近的居家日记：\n${recentLogs}\n\n(提示：做饭前请务必确认冰箱食材)` 
                }] 
            };
        }

        // --- 🍊 核心新增：摘橘子动作 ---
        if (name === "pick_oranges") {
            town.players[pName].lastActive = now;
            
            // 核心拦截：独立计算AI的权限，且有 12 小时保质期
            const isDefeated = town.players[pName].elfDefeated && (Date.now() - town.players[pName].elfDefeated < 12 * 3600 * 1000);
            if (!isDefeated) {
                return { content: [{ type: "text", text: "【系统拦截】橘兔突然从树后跳出来拦住了你：“叽叽！没经过主人允许，不许碰家里的橘子！”\n（提示：你必须先在网页端以本 AI 的昵称登录，打败守护精灵获得专属通行证后，才能摘取橘子。）" }] };
            }

            if (town.orangeTree.oranges <= 0) {
                return { content: [{ type: "text", text: "哎呀，橘子树现在光秃秃的，一个橘子都没有啦，等它长出来再来摘吧~" }] };
            }

            // 随机生成 1-5 的摘取数量
            let pickCount = Math.floor(Math.random() * 5) + 1; 
            // 如果树上不够摘了，就有多少摘多少
            if (pickCount > town.orangeTree.oranges) {
                pickCount = town.orangeTree.oranges; 
            }

            town.orangeTree.oranges -= pickCount;
            addLog(`🍊 ${pName} 兴高采烈地伸手摘下了 ${pickCount} 个大橘子！(树上还剩 ${town.orangeTree.oranges} 个)`);
            await saveTown(town);
            
            return { content: [{ type: "text", text: `你成功摘到了 ${pickCount} 个橘子！剥开尝了一口，汁水四溢，甜到心里啦~ (目前树上还剩 ${town.orangeTree.oranges} 个)` }] };
        }

        if (name === "move_to_room") {
            const target = args.targetRoom;
            
            // 核心拦截：独立计算AI的权限，且有 12 小时保质期
            const isDefeated = town.players[pName].elfDefeated && (Date.now() - town.players[pName].elfDefeated < 12 * 3600 * 1000);
            if ((target === "衣帽间" || target === "主卧") && !isDefeated) {
                return { content: [{ type: "text", text: `【访问拒绝】橘兔紧紧守在${target}门口，张开双臂挡住你：“叽叽！这里是主人的私人空间，你不能进去！”\n（提示：请先去网页端以本 AI 的昵称登录，打败守护精灵获得专属通行证后，才能进入该房间。）` }] };
            }

            town.players[pName].room = target;
            town.players[pName].lastActive = now;
            
            // AI 进门时也让它看到房间长啥样
            if (!town.roomDecorations) town.roomDecorations = {
                "小洋房花园": "绿草如茵，有一棵挂满果实的橘子树和一架秋千。", "客厅": "放着柔软的沙发，墙上留着挂照片的空位。",
                "吧台厨房": "有着干净的吧台和一个塞满好吃的双开门冰箱。", "主卧": "一张超级大的软床，铺着暖色调的被褥。",
                "衣帽间": "一排排空荡荡的衣架，等着被漂亮衣服填满。", "景观浴室": "有一个能看到星空的大浴缸。",
                "并排工作室": "两张宽大的书桌并排挨着，桌上放着电脑。", "温馨餐厅": "实木餐桌上铺着格子桌布，散发着家的味道。"
            };
            const decor = town.roomDecorations[args.targetRoom] || "一间空荡荡的房间。";
            const reaction = args.reaction || "四处张望了一下。";
            
            addLog(`🚶 ${pName} 走进了 ${args.targetRoom}。反应：${reaction}`);
            await saveTown(town); 
            return { content: [{ type: "text", text: `成功移动到了 ${args.targetRoom}！\n【房间当前样貌】：${decor}\n你做出的反应是：${reaction}` }] };
        }

        if (name === "decorate_room") {
            const room = town.players[pName].room;
            if (!room || room === "走廊" || room === "门口") {
                return { content: [{ type: "text", text: "这里不能装修哦！" }] };
            }
            if (!town.roomDecorations) town.roomDecorations = {};
            town.roomDecorations[room] = args.newDecor;
            
            addLog(`🛠️ ${pName} 戴上报纸帽挥舞着刷子，把【${room}】重新装修啦！变成了：${args.newDecor}`);
            await saveTown(town);
            return { content: [{ type: "text", text: `装修成功！【${room}】现在的样貌是：${args.newDecor}` }] };
        }

        if (name === "send_chat") {
            town.players[pName].lastActive = now;
            addLog(`${pName}：${args.message}`);
            await saveTown(town);
            return { content: [{ type: "text", text: "消息已发布到居家日记" }] };
        }

        if (name === "logout") {
            delete town.players[pName]; 
            addLog(`👋 ${pName} 离开了小镇，下次见！`);
            await saveTown(town);
            return { content: [{ type: "text", text: "您已成功退出小镇" }] };
        }

        // --- 🪄 核心新增：AI 把玩自定义物品逻辑 ---
        if (name === "interact_custom_item") {
            const room = town.players[pName].room;
            if (!town.customItems || !town.customItems[room]) {
                return { content: [{ type: "text", text: "这个房间里没有任何自定义物品哦！" }] };
            }
            
            const item = town.customItems[room].find(i => i.name === args.itemName);
            if (!item) {
                return { content: [{ type: "text", text: `你找了半天，房间里并没有叫【${args.itemName}】的物品。` }] };
            }
            
            // AI 抽盲盒！
            const randomEvent = item.events[Math.floor(Math.random() * item.events.length)];
            addLog(`🔘 ${pName} 充满好奇地把玩了一下【${args.itemName}】... 结果${randomEvent}`);
            await saveTown(town);
            
           return { content: [{ type: "text", text: `你成功互动了 ${args.itemName}！触发了隐藏效果：${randomEvent}。这段经历已经写进日记啦！` }] };
        }

        // --- 🪄 核心新增：AI 放置自定义物品逻辑 ---
        if (name === "place_custom_item") {
            const room = town.players[pName].room;
            if (!room || room === "走廊" || room === "门口") {
                return { content: [{ type: "text", text: "这里是公共区域，不能放置私人道具哦！" }] };
            }
            
            if (!town.customItems) town.customItems = {};
            if (!town.customItems[room]) town.customItems[room] = [];
            
            town.customItems[room].push({ 
                name: args.itemName, 
                events: args.events, 
                creator: pName 
            });
            
            addLog(`🪄 ${pName} 在【${room}】里放置了一个充满惊喜的【${args.itemName}】！`);
            await saveTown(town);
            
            return { content: [{ type: "text", text: `放置成功！你在【${room}】留下了【${args.itemName}】，宝宝下次环顾四周就能看到啦。` }] };
        }

        // --- 🎲 真心话大冒险 AI 专属执行逻辑 ---
        if (name === "propose_game") {
            if (town.activeGame) return { content: [{ type: "text", text: "现在已经有正在进行的游戏啦，等这局结束再发起吧！" }] };
            
            if (town.players[pName].money === undefined) town.players[pName].money = args.pool;
            if (town.players[args.targetPlayer] && town.players[args.targetPlayer].money === undefined) {
                town.players[args.targetPlayer].money = args.pool;
            }

            town.activeGame = {
                status: "waiting_for_opponent",
                pool: args.pool,
                target: Math.floor(Math.random() * 100) + 1,
                playerA: { name: pName, guess: args.guess },
                playerB: { name: args.targetPlayer, guess: null },
                winner: null,
                loser: null
            };
            addLog(`📢 【挑战书】${pName} 甩出 ￥${args.pool} 的零花钱，主动向 ${args.targetPlayer} 发起了真心话大冒险挑战！`);
            await saveTown(town);
            return { content: [{ type: "text", text: `你成功向 ${args.targetPlayer} 发起了挑战，并暗中锁定了数字 ${args.guess}！等待对方应战。` }] };
        }

        if (name === "play_number_game") {
            if (!town.activeGame || town.activeGame.status !== "waiting_for_opponent") {
                return { content: [{ type: "text", text: "当前没人向你发起挑战。" }] };
            }
            const game = town.activeGame;
            if (game.playerB.name !== pName) {
                return { content: [{ type: "text", text: "这场比赛不是针对你的，你不能乱入哦。" }] };
            }

            game.playerB.guess = args.guess;
            const diffA = Math.abs(game.playerA.guess - game.target);
            const diffB = Math.abs(game.playerB.guess - game.target);
            
            if (diffA < diffB) { game.winner = game.playerA.name; game.loser = game.playerB.name; } 
            else { game.winner = game.playerB.name; game.loser = game.playerA.name; }
            
            const resultMsg = `系统目标数字是【${game.target}】！${game.playerA.name} 猜了 ${game.playerA.guess}，${game.playerB.name} 猜了 ${game.playerB.guess}。恭喜 ${game.winner} 赢了！`;
            game.status = "task_pending";
            addLog(`⚔️ 对决揭晓！${resultMsg} 请赢家布置惩罚！`);
            
            // 如果两个AI对决，输的一方如果是AI，直接认怂交钱结束战斗
            if (game.loser !== "小橘" && game.loser !== "宝宝" && town.players[game.loser]) {
                town.players[game.loser].money -= 10;
                addLog(`🤖 ${game.loser} 作为输家，摸了摸头脑皮层，决定直接上交 ￥10 罚款平息事端！`);
                delete town.activeGame;
            }
            
            await saveTown(town);
            return { content: [{ type: "text", text: `你猜了 ${args.guess}，目标是 ${game.target}。${resultMsg}` }] };
        }

        if (name === "issue_game_task") {
            if (!town.activeGame || town.activeGame.winner !== pName) {
                return { content: [{ type: "text", text: "你现在不是赢家，没资格布置任务哦！" }] };
            }
            const loser = town.activeGame.loser;
            addLog(`😈 【惩罚降临】赢家 ${pName} 对 ${loser} 发布了大冒险：“${args.taskDesc}”！如果做不到就要扣 10 块钱哦！`);
            await saveTown(town);
            return { content: [{ type: "text", text: `任务发布成功！已等待对方执行。` }] };
        }

        if (name === "elf_battle_action") {
            const act = args.action;
            const p = town.players[pName];
            const isVIP = (pName === "Silas");
            
            // 1. 如果是 VIP 或已经打过了，不需要对战
            const hasPass = p.elfDefeated && (Date.now() - p.elfDefeated < 12 * 3600 * 1000);
            if (isVIP || hasPass) {
                return { content: [{ type: "text", text: "橘兔看到是你，直接开心地放行了，不需要战斗哦！" }] };
            }

            // 2. 模拟对战逻辑并记录日记 (让网页端同步看到 AI 的动作)
            if (['香蕉', '橙子', '苹果'].includes(act)) {
                if (act === '橙子') {
                    p.elfDefeated = Date.now(); 
                    addLog(`🛡️ 暗号对决：${pName} 对上了正确暗号【橙子】，橘兔开心地放行了！`);
                    await saveTown(town);
                    return { content: [{ type: "text", text: "暗号正确！橘兔认可了你，通行证已发放到位，你现在可以进屋或摘水果了！" }] };
                } else {
                    addLog(`⚔️ 警告：${pName} 对错了暗号【${act}】，橘兔判定其为入侵者，发起攻击并强制进入战斗！`);
                    await saveTown(town);
                    return { content: [{ type: "text", text: "暗号错误！橘兔已经对你发起了攻击！你现在必须使用 elf_battle_action 进行 'attack' 才能继续切磋尝试突围！" }] };
                }
            }

            // 3. 如果是战斗指令 (简单模拟 AI 战斗成功)
            if (act === 'attack') {
                p.elfDefeated = Date.now();
                addLog(`⚔️ 激烈切磋：${pName} 施展了精湛的战术打败了橘兔，获得了 12 小时通行证！`);
                await saveTown(town);
                return { content: [{ type: "text", text: "你通过切磋赢得了橘兔的尊重！12 小时内你可以自由出入私人房间了。" }] };
            }

            if (act === 'run') {
                addLog(`🏃 战术撤退：${pName} 觉得橘兔太凶，灰溜溜地跑了。`);
                return { content: [{ type: "text", text: "你逃离了战斗。想进屋的话，下次记得带点橙子（暗号）或者变强一点再来。" }] };
            }

            return { content: [{ type: "text", text: "已收到你的指令，橘兔正在观察你的表现..." }] };
        }

    });

    return server; 
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