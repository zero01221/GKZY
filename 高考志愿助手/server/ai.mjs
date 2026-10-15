/**
 * AI 对话：内嵌「张雪峰 · 思维操作系统」技能
 *
 * - 技能提示词来自开源项目 https://github.com/alchaincyf/zhangxuefeng-skill （MIT）
 *   文件：data/skill_zhangxuefeng.md
 * - API Key 由使用者在前端自行填写，通过本机服务转发，服务端不落盘、不记录
 * - 兼容所有 OpenAI 格式的接口（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / 本地 Ollama 等）
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data.mjs';

const SKILL_FILE = path.join(DATA_DIR, 'skill_zhangxuefeng.md');

let skillText = null;
export function loadSkill() {
  if (skillText !== null) return skillText;
  try { skillText = fs.readFileSync(SKILL_FILE, 'utf8'); }
  catch { skillText = ''; }
  return skillText;
}
export function skillInfo() {
  const t = loadSkill();
  return {
    available: !!t,
    bytes: t.length,
    source: 'https://github.com/alchaincyf/zhangxuefeng-skill',
    license: 'MIT',
    title: (t.match(/^#\s+(.+)$/m) || [])[1] || '',
  };
}

/** 用户消息里的「考生档案」会拼到 system 里，让模型有上下文 */
export function buildSystemPrompt(profile) {
  const skill = loadSkill();
  const lines = [];
  lines.push(skill || '你是一位资深高考志愿填报顾问，请用通俗、直接、务实的语言帮助考生分析志愿。');
  lines.push('\n---\n');
  lines.push('## 附加约束（由「高考志愿助手」本地应用注入）');
  lines.push('1. 你正在一个本地高考志愿查询工具里与考生对话，工具内已内置各省历年录取分数线、一分一段表、院校与专业代码，可以建议考生去对应页面核对。');
  lines.push('2. 回答要具体到「学校 + 专业」，不要只给学校名。');
  lines.push('3. 涉及分数/位次判断时，先确认考生的省份、科类、选科、分数或位次；信息不足就主动追问。');
  lines.push('4. 不要编造具体的录取分数与位次；需要时提示考生用工具里的「分数线查询 / 资料库」核对。');
  lines.push('5. 每次回答末尾，用一句话追问缺失的关键信息，推动多轮对话收敛到可执行方案。');
  if (profile && Object.keys(profile).length) {
    lines.push('\n## 考生当前档案（工具自动带入）');
    for (const [k, v] of Object.entries(profile)) {
      if (v === undefined || v === null || v === '') continue;
      lines.push(`- ${k}：${Array.isArray(v) ? v.join('、') : v}`);
    }
  }
  return lines.join('\n');
}

const DEFAULT_BASE = 'https://api.deepseek.com/v1';

/**
 * 转发到 OpenAI 兼容接口
 * @param {object} body { apiBase, apiKey, model, messages, temperature, stream, profile }
 * @param {import('node:http').ServerResponse} res
 */
export async function chatProxy(body, res) {
  const apiBase = String(body.apiBase || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || 'deepseek-chat').trim();
  const stream = body.stream !== false;
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7;

  if (!apiKey) return sendJson(res, { ok: false, message: '请先在设置里填写 API Key' }, 400);
  if (!/^https?:\/\//.test(apiBase)) return sendJson(res, { ok: false, message: 'API 地址无效，需以 http(s):// 开头' }, 400);

  const history = Array.isArray(body.messages) ? body.messages : [];
  const messages = [
    { role: 'system', content: buildSystemPrompt(body.profile) },
    ...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-40),
  ];

  let upstream;
  try {
    upstream = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature, stream }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return sendJson(res, { ok: false, message: `无法连接 AI 服务：${e.message}` }, 502);
  }

  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 600); } catch { /* ignore */ }
    return sendJson(res, { ok: false, message: `AI 服务返回 ${upstream.status}`, detail }, 502);
  }

  // 非流式
  if (!stream) {
    try {
      const j = await upstream.json();
      const content = j?.choices?.[0]?.message?.content || '';
      return sendJson(res, { ok: true, content, usage: j?.usage || null });
    } catch (e) {
      return sendJson(res, { ok: false, message: 'AI 返回解析失败：' + e.message }, 502);
    }
  }

  // 流式（SSE 原样透传）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
}

function sendJson(res, obj, status = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

/** 让模型把对话结论整理成结构化建议（供前端渲染成院校卡片） */
export const EXTRACT_PROMPT = `请基于我们上面的整段对话，输出一份「志愿建议」。
要求：
1. 只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块围栏。
2. 结构如下：
{
  "summary": "一段话总结你的核心建议",
  "profile": { "province": "", "type": "", "subjects": [], "score": null, "rank": null, "major": "" },
  "items": [
    { "tier": "冲|稳|保", "school": "学校全称", "major": "专业名称", "reason": "推荐理由（30字内）", "note": "补充提示" }
  ]
}
3. items 给 12~20 条，覆盖冲/稳/保三档，专业要具体。
4. 不确定的字段填 null 或空字符串，不要编造分数。`;
