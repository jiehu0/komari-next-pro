"use strict";

const fs = require("fs");
const path = require("path");
const server = require("server");
const core = require("./lib/core");

const HISTORY_FILE = path.join(__storageDir__, "history.json");
const HISTORY_TEMP_FILE = path.join(__storageDir__, "history.json.tmp");
const CONFIG_FILE = path.join(__storageDir__, "config.json");
const CONFIG_TEMP_FILE = path.join(__storageDir__, "config.json.tmp");
const SCHEDULE_STATE_FILE = path.join(__storageDir__, "schedule-state.json");
const SCHEDULE_STATE_TEMP_FILE = path.join(__storageDir__, "schedule-state.json.tmp");

let currentRun = null;
let unloading = false;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return fallback; }
}

function writeJSON(file, tempFile, value) {
  fs.writeFileSync(tempFile, JSON.stringify(value), "utf8");
  fs.renameSync(tempFile, file);
}

function readHistory() {
  return core.normalizeHistory(readJSON(HISTORY_FILE, core.emptyHistory()));
}

function writeHistory(history) {
  writeJSON(HISTORY_FILE, HISTORY_TEMP_FILE, history);
}

function readConfig() {
  return core.normalizeConfig(readJSON(CONFIG_FILE, core.DEFAULT_CONFIG));
}

function writeConfig(config) {
  const normalized = core.normalizeConfig(config);
  writeJSON(CONFIG_FILE, CONFIG_TEMP_FILE, normalized);
  return normalized;
}

function readScheduleState() {
  const value = readJSON(SCHEDULE_STATE_FILE, {});
  return value && typeof value === "object" ? value : {};
}

function writeScheduleState(state) {
  writeJSON(SCHEDULE_STATE_FILE, SCHEDULE_STATE_TEMP_FILE, state);
}

function setJSONHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
}

function sendJSON(res, statusCode, body) {
  setJSONHeaders(res);
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function hasAdminRole(context) {
  if (!context) return false;
  if (context.role === "admin") return true;
  const roles = context.principal && context.principal.roles;
  return Array.isArray(roles) && roles.includes("admin");
}

function validUUID(value) {
  return /^[a-zA-Z0-9-]{8,64}$/.test(String(value || ""));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listClients() {
  const raw = await server.call("admin:listClients");
  return (Array.isArray(raw) ? raw : []).map(core.clientInfo).filter((client) => client.uuid);
}

async function getClient(uuid) {
  const raw = await server.call("admin:getClient", { uuid });
  return core.clientInfo(raw);
}

function taskResultFields(result) {
  return {
    client: String(core.property(result, "client", "Client") || ""),
    output: String(core.property(result, "result", "Result") || ""),
    exitCode: Number(core.property(result, "exit_code", "ExitCode") ?? -1),
    finishedAt: String(core.property(result, "finished_at", "FinishedAt") || new Date().toISOString()),
  };
}

function taskResults(task) {
  const results = core.property(task, "results", "Results");
  return Array.isArray(results) ? results : [];
}

async function waitForTask(taskId, expectedCount) {
  const deadline = Date.now() + core.TASK_TIMEOUT_MS;
  let latest = [];
  while (!unloading && Date.now() < deadline) {
    try {
      const task = await server.call("admin:getTaskById", { task_id: taskId });
      latest = taskResults(task).filter(core.taskResultFinished);
      if (latest.length >= expectedCount) return latest;
    } catch (error) {
      console.error(`[benchmark] task ${taskId} poll failed: ${error.message}`);
    }
    await delay(core.POLL_INTERVAL_MS);
  }
  return latest;
}

function saveTaskResults(test, targets, rawResults, taskId, source) {
  const byClient = new Map();
  rawResults.map(taskResultFields).forEach((result) => byClient.set(result.client, result));
  let history = readHistory();
  const savedAt = new Date();
  for (const client of targets) {
    const result = byClient.get(client.uuid);
    const record = result
      ? core.parseBenchmarkOutput(result.output, result.exitCode, result.finishedAt, test)
      : { test, time: savedAt.toISOString(), status: "timeout", error: "agent result timed out", meta: {} };
    record.task_id = taskId;
    record.source = source;
    history = core.mergeHistory(history, client.uuid, record, savedAt);
  }
  writeHistory(history);
}

async function runOneTest(test, targets, source) {
  if (unloading) return;
  const dispatched = await server.call("admin:exec", {
    command: core.BENCHMARK_COMMANDS[test],
    clients: targets.map((client) => client.uuid),
  });
  const taskId = String(core.property(dispatched, "task_id", "TaskId", "TaskID") || "");
  if (!taskId) throw new Error("Komari did not return a task id");
  currentRun.active_test = test;
  currentRun.task_id = taskId;
  const results = await waitForTask(taskId, targets.length);
  if (!unloading) saveTaskResults(test, targets, results, taskId, source);
  currentRun.completed_tests.push(test);
}

async function startBenchmarks(tests, requestedUUIDs, source) {
  if (currentRun) {
    const error = new Error("a benchmark run is already active");
    error.code = "busy";
    throw error;
  }
  const selectedTests = [...new Set(tests)].filter((test) => core.TEST_KEYS.includes(test));
  if (!selectedTests.length) throw new Error("no valid benchmark tests");
  const clients = await listClients();
  const requested = Array.isArray(requestedUUIDs) ? new Set(requestedUUIDs) : null;
  const targets = requested ? clients.filter((client) => requested.has(client.uuid)) : clients;
  if (!targets.length) throw new Error("no matching clients");

  currentRun = {
    source,
    started_at: new Date().toISOString(),
    clients: targets.map((client) => client.uuid),
    tests: selectedTests,
    completed_tests: [],
    active_test: null,
    task_id: null,
  };
  const accepted = { ...currentRun };
  void (async () => {
    try {
      for (const test of selectedTests) await runOneTest(test, targets, source);
    } catch (error) {
      console.error(`[benchmark] run failed: ${error.message}`);
    } finally {
      currentRun = null;
    }
  })();
  return accepted;
}

async function historyRoute(req, res) {
  const uuid = String(req.query.uuid || "");
  if (!validUUID(uuid)) return sendJSON(res, 400, { status: "error", message: "invalid uuid" });
  try {
    const client = await getClient(uuid);
    if (!client.uuid || (client.hidden && !hasAdminRole(req.context))) return sendJSON(res, 404, { status: "error", message: "not found" });
    const history = readHistory();
    sendJSON(res, 200, { status: "success", data: {
      version: history.version,
      uuid,
      retention_days: core.RETENTION_DAYS,
      updated_at: history.updated_at,
      records: core.historyForNode(history, uuid),
    } });
  } catch (_) {
    sendJSON(res, 404, { status: "error", message: "not found" });
  }
}

async function runRoute(req, res) {
  if (!hasAdminRole(req.context)) return sendJSON(res, 403, { status: "error", message: "admin required" });
  const uuid = String(req.query.uuid || "");
  if (uuid && !validUUID(uuid)) return sendJSON(res, 400, { status: "error", message: "invalid uuid" });
  const requestedTest = String(req.query.test || "all");
  const tests = requestedTest === "all" ? core.TEST_KEYS : [requestedTest];
  if (requestedTest !== "all" && !core.TEST_KEYS.includes(requestedTest)) return sendJSON(res, 400, { status: "error", message: "invalid test" });
  try {
    const run = await startBenchmarks(tests, uuid ? [uuid] : null, "manual");
    sendJSON(res, 202, { status: "accepted", data: run });
  } catch (error) {
    sendJSON(res, error.code === "busy" ? 409 : 400, { status: "error", message: error.message });
  }
}

function statusRoute(req, res) {
  if (!hasAdminRole(req.context)) return sendJSON(res, 403, { status: "error", message: "admin required" });
  sendJSON(res, 200, { status: "success", data: { running: Boolean(currentRun), run: currentRun } });
}

function configRoute(req, res) {
  if (!hasAdminRole(req.context)) return sendJSON(res, 403, { status: "error", message: "admin required" });
  const offsetMinutes = -new Date().getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  sendJSON(res, 200, { status: "success", data: {
    config: readConfig(),
    timezone: `UTC${offsetSign}${offsetHours}:${offsetRemainder}`,
  } });
}

function updateConfigRoute(req, res) {
  if (!hasAdminRole(req.context)) return sendJSON(res, 403, { status: "error", message: "admin required" });
  try {
    const value = JSON.parse(String(req.body || "{}"));
    const config = writeConfig(value);
    sendJSON(res, 200, { status: "success", data: { config } });
  } catch (_) {
    sendJSON(res, 400, { status: "error", message: "invalid JSON body" });
  }
}

function schedulerTick() {
  if (currentRun || unloading) return;
  const now = new Date();
  const state = readScheduleState();
  const tests = core.dueTests(readConfig(), state, now);
  if (!tests.length) return;
  void startBenchmarks(tests, null, "schedule").then(() => {
    const scheduledAt = now.toISOString();
    for (const test of tests) state[test] = scheduledAt;
    writeScheduleState(state);
  }).catch((error) => {
    if (error.code !== "busy") console.error(`[benchmark] scheduled run failed: ${error.message}`);
  });
}

function load() {
  unloading = false;
  writeConfig(readConfig());
  server.route("GET", "/api/plugin/komari-benchmark/history", historyRoute);
  server.route("POST", "/api/plugin/komari-benchmark/run", runRoute);
  server.route("GET", "/api/plugin/komari-benchmark/status", statusRoute);
  server.route("GET", "/api/plugin/komari-benchmark/config", configRoute);
  server.route("POST", "/api/plugin/komari-benchmark/config", updateConfigRoute);
  server.cron(core.SCHEDULER_TICK, schedulerTick);
  console.log(`[benchmark] loaded; scheduler=${core.SCHEDULER_TICK}; retention=${core.RETENTION_DAYS}d`);
}

function unload() {
  unloading = true;
  console.log("[benchmark] unloaded");
}
