"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../lib/core");
const script = fs.readFileSync(path.join(__dirname, "../script.js"), "utf8");
const A = "test-node-0001";
const B = "test-node-0002";

function plugin(files = new Map(), afterDispatch) {
  const routes = new Map();
  const commands = [];
  const tasks = new Map();
  const clients = [{ uuid: A }, { uuid: B }];
  const storage = {
    readFileSync(p) { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
    writeFileSync(p, s) { files.set(p, s); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const server = {
    route(method, route, handler) { routes.set(`${method} ${route}`, handler); },
    cron() {},
    async call(method, args) {
      if (method === "admin:listClients") return clients;
      if (method === "admin:getClient") return clients.find((c) => c.uuid === args.uuid) || {};
      if (method === "admin:exec") {
        commands.push(args);
        const id = String(commands.length);
        tasks.set(id, args.clients.map((uuid) => ({ client: uuid, result: "KMB_STATUS=unsupported", exit_code: 0, finished_at: new Date().toISOString() })));
        if (afterDispatch) await afterDispatch();
        return { task_id: id };
      }
      if (method === "admin:getTaskById") return { results: tasks.get(args.task_id) };
      throw new Error(`unexpected RPC: ${method}`);
    },
  };
  const context = vm.createContext({
    __storageDir__: "/storage", console: { log() {}, error() {} }, setTimeout,
    require(name) { return ({ fs: storage, path, server, "./lib/core": core })[name]; },
  });
  vm.runInContext(script, context);
  context.load();
  async function request(method, route, body, uuid, admin = true) {
    let result;
    const res = { statusCode: 200, setHeader() {}, end(s) { result = { ...JSON.parse(s), status: this.statusCode }; } };
    await routes.get(`${method} /api/plugin/komari-benchmark/${route}`)({ query: { uuid }, body: JSON.stringify(body), context: admin ? { role: "admin" } : {} }, res);
    return result;
  }
  async function idle() {
    for (let i = 0; i < 30; i++) {
      if (!(await request("GET", "status")).data.running) return;
      await new Promise(setImmediate);
    }
    throw new Error("run did not finish");
  }
  return { context, files, commands, request, idle };
}

test("node settings default to allowed and ignore malformed flags", () => {
  assert.equal(core.isNodeEnabled({}, A), true);
  const c = core.normalizeConfig({ node_enabled: { [A]: false, [B]: "false", invalid: false } });
  assert.deepEqual(c.node_enabled, { [A]: false });
});

test("node switches require admin, a real node and a boolean", async () => {
  const p = plugin();
  assert.equal((await p.request("POST", "node", { enabled: false }, A, false)).status, 403);
  assert.equal((await p.request("POST", "node", { enabled: "false" }, A)).status, 400);
  assert.equal((await p.request("POST", "node", { enabled: false }, "unknown-node")).status, 404);
  assert.equal((await p.request("POST", "node", { enabled: false }, A)).status, 200);
});

test("paused nodes keep history, survive reload and reject targeted manual tests", async () => {
  const p = plugin();
  const history = { version: 2, updated_at: null, records: { [A]: [{ test: "sysbench", time: new Date().toISOString(), status: "ok" }] } };
  p.files.set("/storage/history.json", JSON.stringify(history));
  await p.request("POST", "node", { enabled: false }, A);
  const reloaded = plugin(p.files);
  const result = await reloaded.request("GET", "history", undefined, A, false);
  assert.equal(result.status, 200);
  assert.equal(result.data.enabled, false);
  assert.equal(result.data.records.length, 1);
  assert.equal(p.files.get("/storage/history.json"), JSON.stringify(history));
  assert.equal((await reloaded.request("POST", "run", undefined, A)).status, 400);
  assert.equal(reloaded.commands.length, 0);
});

test("global schedule saves cannot overwrite per-node switches", async () => {
  const p = plugin();
  const old = (await p.request("GET", "config")).data.config;
  await p.request("POST", "node", { enabled: false }, A);
  await p.request("POST", "config", old);
  assert.equal((await p.request("GET", "config")).data.config.node_enabled[A], false);
});

for (const source of ["manual", "schedule"]) {
  test(`${source} bulk runs exclude paused nodes`, async () => {
    const p = plugin();
    await p.request("POST", "node", { enabled: false }, A);
    await p.context.startBenchmarks(["sysbench"], null, source);
    await p.idle();
    assert.equal(p.commands.length, 1);
    assert.deepEqual(Array.from(p.commands[0].clients), [B]);
  });
}

test("all paused nodes skip schedules without issuing commands", async () => {
  const p = plugin();
  await p.request("POST", "node", { enabled: false }, A);
  await p.request("POST", "node", { enabled: false }, B);
  assert.equal((await p.context.startBenchmarks(["fio"], null, "schedule")).skipped, true);
  assert.equal(p.commands.length, 0);
  await p.request("POST", "node", { enabled: true }, A);
  await p.context.startBenchmarks(["fio"], null, "manual");
  await p.idle();
  assert.deepEqual(Array.from(p.commands[0].clients), [A]);
});

test("turning off a node during a suite prevents subsequent tests", async () => {
  const p = plugin(new Map(), async () => p.request("POST", "node", { enabled: false }, A));
  await p.context.startBenchmarks(["sysbench", "fio"], [A], "manual");
  await p.idle();
  assert.equal(p.commands.length, 1);
});
