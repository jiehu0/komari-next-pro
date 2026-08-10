"use strict";

const fs = require("fs");
const path = require("path");
const server = require("server");
const core = require("./lib/core");

const HISTORY_FILE = path.join(__storageDir__, "history.json");
const HISTORY_TEMP_FILE = path.join(__storageDir__, "history.json.tmp");

let currentRun = null;
let unloading = false;

function readHistory() {
  try {
    return core.normalizeHistory(JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")));
  } catch (_) {
    return core.emptyHistory();
  }
}

function writeHistory(history) {
  fs.writeFileSync(HISTORY_TEMP_FILE, JSON.stringify(history), "utf8");
  fs.renameSync(HISTORY_TEMP_FILE, HISTORY_FILE);
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

function saveTaskResults(targets, rawResults, taskId, source) {
  const byClient = new Map();
  rawResults.map(taskResultFields).forEach((result) => byClient.set(result.client, result));
  let history = readHistory();
  const savedAt = new Date();

  for (const client of targets) {
    const result = byClient.get(client.uuid);
    const record = result
      ? core.parseBenchmarkOutput(result.output, result.exitCode, result.finishedAt)
      : { time: savedAt.toISOString(), status: "timeout", error: "agent result timed out", meta: {} };
    record.task_id = taskId;
    record.source = source;
    history = core.mergeHistory(history, client.uuid, record, savedAt);
  }
  writeHistory(history);
}

async function startBenchmarks(requestedUUIDs, source) {
  if (currentRun) {
    const error = new Error("a benchmark run is already active");
    error.code = "busy";
    throw error;
  }

  const clients = await listClients();
  const requested = Array.isArray(requestedUUIDs) ? new Set(requestedUUIDs) : null;
  const targets = requested ? clients.filter((client) => requested.has(client.uuid)) : clients;
  if (!targets.length) throw new Error("no matching clients");

  const dispatched = await server.call("admin:exec", {
    command: core.BENCHMARK_COMMAND,
    clients: targets.map((client) => client.uuid),
  });
  const taskId = String(core.property(dispatched, "task_id", "TaskId", "TaskID") || "");
  if (!taskId) throw new Error("Komari did not return a task id");

  currentRun = {
    task_id: taskId,
    source,
    started_at: new Date().toISOString(),
    clients: targets.map((client) => client.uuid),
  };

  void (async () => {
    try {
      const results = await waitForTask(taskId, targets.length);
      if (!unloading) saveTaskResults(targets, results, taskId, source);
    } catch (error) {
      console.error(`[benchmark] task ${taskId} failed: ${error.message}`);
    } finally {
      currentRun = null;
    }
  })();

  return currentRun;
}

async function historyRoute(req, res) {
  const uuid = String(req.query.uuid || "");
  if (!validUUID(uuid)) {
    sendJSON(res, 400, { status: "error", message: "invalid uuid" });
    return;
  }

  try {
    const client = await getClient(uuid);
    if (!client.uuid || (client.hidden && !hasAdminRole(req.context))) {
      sendJSON(res, 404, { status: "error", message: "not found" });
      return;
    }
    const history = readHistory();
    sendJSON(res, 200, {
      status: "success",
      data: {
        version: history.version,
        uuid,
        schedule: core.SCHEDULE,
        retention_days: core.RETENTION_DAYS,
        updated_at: history.updated_at,
        records: core.historyForNode(history, uuid),
      },
    });
  } catch (error) {
    sendJSON(res, 404, { status: "error", message: "not found" });
  }
}

async function runRoute(req, res) {
  if (!hasAdminRole(req.context)) {
    sendJSON(res, 403, { status: "error", message: "admin required" });
    return;
  }
  const uuid = String(req.query.uuid || "");
  const requested = uuid ? [uuid] : null;
  if (uuid && !validUUID(uuid)) {
    sendJSON(res, 400, { status: "error", message: "invalid uuid" });
    return;
  }
  try {
    const run = await startBenchmarks(requested, "manual");
    sendJSON(res, 202, { status: "accepted", data: run });
  } catch (error) {
    sendJSON(res, error.code === "busy" ? 409 : 400, { status: "error", message: error.message });
  }
}

function statusRoute(req, res) {
  if (!hasAdminRole(req.context)) {
    sendJSON(res, 403, { status: "error", message: "admin required" });
    return;
  }
  sendJSON(res, 200, { status: "success", data: { running: Boolean(currentRun), run: currentRun } });
}

function load() {
  unloading = false;
  server.route("GET", "/api/plugin/komari-benchmark/history", historyRoute);
  server.route("POST", "/api/plugin/komari-benchmark/run", runRoute);
  server.route("GET", "/api/plugin/komari-benchmark/status", statusRoute);
  server.cron(core.SCHEDULE, () => {
    void startBenchmarks(null, "schedule").catch((error) => {
      if (error.code !== "busy") console.error(`[benchmark] scheduled run failed: ${error.message}`);
    });
  });
  console.log(`[benchmark] loaded; schedule=${core.SCHEDULE}; retention=${core.RETENTION_DAYS}d`);
}

function unload() {
  unloading = true;
  console.log("[benchmark] unloaded");
}
