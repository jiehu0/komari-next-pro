"use strict";
const fs = require("fs");
const path = require("path");
const server = require("server");
const file = path.join(__storageDir__, "layout.json");
function read() {
  if (!fs.existsSync(file)) return { revision: 0, grid: [], table: [], follow: true };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function admin(req) {
  return req.context?.role === "admin" || req.context?.principal?.roles?.includes("admin");
}
function send(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}
function complete(order, ids) {
  const known = new Set(ids);
  return [...new Set([...order.filter(id => known.has(id)), ...ids])];
}
function merge(current, visible) {
  const selected = new Set(visible);
  let i = 0;
  return current.map(id => selected.has(id) ? visible[i++] : id);
}
async function clients() {
  const rows = await server.call("admin:listClients");
  return rows.slice().sort((a, b) => (a.weight || 0) - (b.weight || 0));
}
async function get(req, res) {
  const rows = await clients();
  const ids = rows.filter(c => admin(req) || !c.hidden).map(c => c.uuid);
  const state = read();
  send(res, 200, { ...state, grid: complete(state.grid, ids), table: complete(state.table.length ? state.table : state.grid, ids) });
}
async function update(req, res) {
  if (!admin(req)) return send(res, 403, { message: "仅管理员可以修改排序" });
  let body;
  try { body = JSON.parse(String(req.body)); } catch (_) { return send(res, 400, { message: "无效请求" }); }
  if (!body || !["grid", "table", "follow"].includes(body.kind)) return send(res, 400, { message: "无效排序类型" });
  const ids = (await clients()).map(c => c.uuid);
  const state = read();
  if (body.revision !== state.revision) return send(res, 409, { message: "排序已在其他客户端更新，请重试" });
  if (body.kind === "follow") {
    if (typeof body.value !== "boolean") return send(res, 400, { message: "无效开关值" });
    if (!state.table.length) state.table = complete(state.grid, ids);
    state.follow = body.value;
  } else {
    if (body.kind === "table" && state.follow) return send(res, 409, { message: "请先关闭跟随卡片顺序" });
    const order = body.value;
    if (!Array.isArray(order) || !order.length || order.length > ids.length || new Set(order).size !== order.length || order.some(id => !ids.includes(id))) return send(res, 400, { message: "无效节点顺序" });
    const current = complete(state[body.kind].length ? state[body.kind] : state.grid, ids);
    state[body.kind] = merge(current, order);
  }
  state.revision++;
  fs.writeFileSync(file + ".tmp", JSON.stringify(state), "utf8");
  fs.renameSync(file + ".tmp", file);
  send(res, 200, { ...state, grid: complete(state.grid, ids), table: complete(state.table.length ? state.table : state.grid, ids) });
}
function load() {
  server.route("GET", "/api/plugin/komari-layout/order", get);
  server.route("POST", "/api/plugin/komari-layout/order", update);
}
function unload() {}
