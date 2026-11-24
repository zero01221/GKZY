/**
 * 本地会话与登录（仅单人本地使用场景）
 *
 * ⚠️ 弱安全声明：账号 admin / 密码 123456 硬编码、无加密、无限流，
 *    会话仅存于服务端内存 Map（重启即失效）。仅限个人本地使用，勿公网部署。
 */
import crypto from 'node:crypto';

export const USER = 'admin';
export const PASS = '123456';
export const COOKIE_NAME = 'gk_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** token -> Session */
const sessions = new Map();

function readToken(req) {
  const raw = req?.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return '';
}

/** 校验账号密码；成功返回随机 token，失败返回 null。 */
export function login(user, pass) {
  if (String(user ?? '') !== USER || String(pass ?? '') !== PASS) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  sessions.set(token, { token, user: USER, createdAt, expiresAt });
  return token;
}

/** 退出登录：删除内存会话。 */
export function logout(token) {
  if (token) sessions.delete(token);
}

/** 读取当前请求的有效会话；无会话或已过期返回 null。 */
export function getSession(req) {
  const token = readToken(req);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.parse(s.expiresAt) <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/**
 * 鉴权门禁：未登录时直接写出 401，返回 false。
 * 与 server.mjs 的 sendJson 保持同一响应风格（不引入新信封）。
 */
export function requireAuth(req, res) {
  const s = getSession(req);
  if (s) return true;
  const body = Buffer.from(JSON.stringify({ ok: false, message: '请先登录' }));
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return false;
}

/** 下发 HttpOnly 会话 Cookie（本地 HTTP，不加 Secure）。 */
export function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
}

/** 清除会话 Cookie。 */
export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/** 供自检/测试使用：当前有效会话数量。 */
export function sessionCount() {
  return sessions.size;
}
