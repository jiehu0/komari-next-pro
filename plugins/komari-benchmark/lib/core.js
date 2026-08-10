"use strict";

const RETENTION_DAYS = 30;
const SCHEDULE = "30 3 * * *";
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const BENCHMARK_COMMAND = String.raw`set -u
export LC_ALL=C
LOCK_DIR=/var/tmp/komari-benchmark.lock
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "KMB_STATUS=busy"
  echo "KMB_ERROR=benchmark already running"
  exit 0
fi
DATA_FILE="$LOCK_DIR/fio.bin"
JSON_FILE="$LOCK_DIR/fio.json"
cleanup_benchmark() {
  rm -f "$DATA_FILE" "$JSON_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_benchmark EXIT HUP INT TERM

echo "KMB_VERSION=1"
echo "KMB_TIME=$(date -u +%FT%TZ)"
echo "KMB_HOST_ARCH=$(uname -m)"

MISSING=""
for TOOL in sysbench fio; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    if [ -n "$MISSING" ]; then MISSING="$MISSING,$TOOL"; else MISSING="$TOOL"; fi
  fi
done
if [ -n "$MISSING" ]; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: $MISSING"
  exit 0
fi

FREE_KB=$(df -Pk /var/tmp | awk 'NR == 2 { print $4 }')
if [ -z "$FREE_KB" ] || [ "$FREE_KB" -lt 786432 ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=less than 768 MiB free in /var/tmp"
  exit 0
fi

THREADS=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
echo "KMB_CPU_THREADS=$THREADS"
echo "KMB_SYSBENCH_VERSION=$(sysbench --version 2>/dev/null | head -n 1)"
echo "KMB_FIO_VERSION=$(fio --version 2>/dev/null | head -n 1)"

CPU_SINGLE=$(sysbench cpu --threads=1 --time=10 --cpu-max-prime=20000 run 2>&1 | awk '/events per second:/ { print $4; exit }')
CPU_MULTI=$(sysbench cpu --threads="$THREADS" --time=10 --cpu-max-prime=20000 run 2>&1 | awk '/events per second:/ { print $4; exit }')
MEM_READ=$(sysbench memory --threads=1 --time=10 --memory-block-size=1M --memory-total-size=100T --memory-oper=read --memory-access-mode=seq run 2>&1 | awk '/transferred \(/ { gsub(/[()]/, "", $(NF-1)); print $(NF-1); exit }')
MEM_WRITE=$(sysbench memory --threads=1 --time=10 --memory-block-size=1M --memory-total-size=100T --memory-oper=write --memory-access-mode=seq run 2>&1 | awk '/transferred \(/ { gsub(/[()]/, "", $(NF-1)); print $(NF-1); exit }')

if [ -z "$CPU_SINGLE" ] || [ -z "$CPU_MULTI" ] || [ -z "$MEM_READ" ] || [ -z "$MEM_WRITE" ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=sysbench output could not be parsed"
  exit 0
fi

echo "KMB_CPU_SINGLE_EPS=$CPU_SINGLE"
echo "KMB_CPU_MULTI_EPS=$CPU_MULTI"
echo "KMB_MEMORY_READ_MIB_S=$MEM_READ"
echo "KMB_MEMORY_WRITE_MIB_S=$MEM_WRITE"

run_fio() {
  BS="$1"
  KEY="$2"
  if ! fio --name=komari-benchmark --filename="$DATA_FILE" --size=256m --rw=randrw --rwmixread=50 --bs="$BS" --ioengine=libaio --iodepth=16 --direct=1 --time_based=1 --runtime=10 --randrepeat=0 --group_reporting=1 --output-format=json --output="$JSON_FILE" >/dev/null 2>&1; then
    echo "KMB_STATUS=error"
    echo "KMB_ERROR=fio $BS failed"
    return 1
  fi
  echo "KMB_FIO_${"$"}{KEY}_BEGIN"
  tr -d '\r\n' < "$JSON_FILE"
  echo
  echo "KMB_FIO_${"$"}{KEY}_END"
}

run_fio 4k 4K || exit 0
run_fio 64k 64K || exit 0
run_fio 512k 512K || exit 0
run_fio 1m 1M || exit 0
echo "KMB_STATUS=ok"`;

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function property(object, ...names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) {
    if (object[name] !== undefined) return object[name];
  }
  return undefined;
}

function clientInfo(client) {
  return {
    uuid: String(property(client, "uuid", "UUID", "Uuid") || ""),
    name: String(property(client, "name", "Name") || ""),
    hidden: Boolean(property(client, "hidden", "Hidden")),
  };
}

function taskResultFinished(result) {
  const exitCode = property(result, "exit_code", "ExitCode");
  const finishedAt = property(result, "finished_at", "FinishedAt");
  return exitCode !== null && exitCode !== undefined && Boolean(finishedAt);
}

function extractMarker(output, key) {
  const match = String(output || "").match(new RegExp(`^KMB_${key}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

function extractFioJSON(output, key) {
  const pattern = new RegExp(`KMB_FIO_${key}_BEGIN\\s*([\\s\\S]*?)\\s*KMB_FIO_${key}_END`);
  const match = String(output || "").match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
}

function fioBandwidthMib(section) {
  const bw = numberValue(section && section.bw);
  if (bw !== null) return bw / 1024;
  const bytes = numberValue(section && section.bw_bytes);
  return bytes === null ? null : bytes / 1024 / 1024;
}

function parseFioResult(payload) {
  const job = payload && Array.isArray(payload.jobs) ? payload.jobs[0] : null;
  if (!job) return null;
  const readMib = fioBandwidthMib(job.read);
  const writeMib = fioBandwidthMib(job.write);
  const readIops = numberValue(job.read && job.read.iops);
  const writeIops = numberValue(job.write && job.write.iops);
  if ([readMib, writeMib, readIops, writeIops].some((value) => value === null)) return null;
  return {
    read_mib_s: readMib,
    write_mib_s: writeMib,
    total_mib_s: readMib + writeMib,
    read_iops: readIops,
    write_iops: writeIops,
    total_iops: readIops + writeIops,
  };
}

function parseBenchmarkOutput(output, exitCode, fallbackTime) {
  const rawOutput = String(output || "").trim();
  const agentError = rawOutput.replace(/\s+/g, " ").slice(0, 300);
  const status = extractMarker(output, "STATUS") || (Number(exitCode) === 0 ? "error" : "failed");
  const record = {
    time: extractMarker(output, "TIME") || fallbackTime || new Date().toISOString(),
    status,
    error: extractMarker(output, "ERROR") || (Number(exitCode) === 0 ? "" : agentError || `agent exit code ${exitCode}`),
    meta: {
      arch: extractMarker(output, "HOST_ARCH"),
      sysbench_version: extractMarker(output, "SYSBENCH_VERSION"),
      fio_version: extractMarker(output, "FIO_VERSION"),
    },
  };

  if (status !== "ok") return record;

  const cpuSingle = numberValue(extractMarker(output, "CPU_SINGLE_EPS"));
  const cpuMulti = numberValue(extractMarker(output, "CPU_MULTI_EPS"));
  const cpuThreads = numberValue(extractMarker(output, "CPU_THREADS"));
  const memoryRead = numberValue(extractMarker(output, "MEMORY_READ_MIB_S"));
  const memoryWrite = numberValue(extractMarker(output, "MEMORY_WRITE_MIB_S"));
  const fio = {
    "4k": parseFioResult(extractFioJSON(output, "4K")),
    "64k": parseFioResult(extractFioJSON(output, "64K")),
    "512k": parseFioResult(extractFioJSON(output, "512K")),
    "1m": parseFioResult(extractFioJSON(output, "1M")),
  };
  if ([cpuSingle, cpuMulti, cpuThreads, memoryRead, memoryWrite].some((value) => value === null) || Object.values(fio).some((value) => value === null)) {
    record.status = "error";
    record.error = "benchmark output is incomplete";
    return record;
  }

  record.sysbench = {
    cpu: { single_eps: cpuSingle, multi_eps: cpuMulti, threads: cpuThreads },
    memory: { read_mib_s: memoryRead, write_mib_s: memoryWrite },
  };
  record.fio = fio;
  return record;
}

function emptyHistory() {
  return { version: 1, updated_at: null, records: {} };
}

function normalizeHistory(value) {
  if (!value || typeof value !== "object" || value.version !== 1 || !value.records || typeof value.records !== "object") {
    return emptyHistory();
  }
  return value;
}

function mergeHistory(historyValue, uuid, record, now) {
  const history = normalizeHistory(historyValue);
  const currentTime = now instanceof Date ? now : new Date(now || Date.now());
  const cutoff = currentTime.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const records = Array.isArray(history.records[uuid]) ? history.records[uuid].slice() : [];
  records.push(record);
  history.records[uuid] = records
    .filter((item) => Number.isFinite(new Date(item.time).getTime()) && new Date(item.time).getTime() >= cutoff)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  history.updated_at = currentTime.toISOString();
  return history;
}

function historyForNode(historyValue, uuid) {
  const history = normalizeHistory(historyValue);
  return Array.isArray(history.records[uuid]) ? history.records[uuid] : [];
}

module.exports = {
  BENCHMARK_COMMAND,
  POLL_INTERVAL_MS,
  RETENTION_DAYS,
  SCHEDULE,
  TASK_TIMEOUT_MS,
  clientInfo,
  emptyHistory,
  historyForNode,
  mergeHistory,
  normalizeHistory,
  parseBenchmarkOutput,
  parseFioResult,
  property,
  taskResultFinished,
};
