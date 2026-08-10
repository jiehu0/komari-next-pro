"use strict";

const RETENTION_DAYS = 30;
const SCHEDULER_TICK = "* * * * *";
const TASK_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const TEST_KEYS = ["sysbench", "memory", "fio", "geekbench5"];
const GEEKBENCH5_CPU_THRESHOLD = 50;

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  schedules: {
    sysbench: { enabled: true, frequency: "daily", time: "03:30", weekday: 0, day: 1 },
    memory: { enabled: true, frequency: "daily", time: "03:45", weekday: 0, day: 1 },
    fio: { enabled: true, frequency: "weekly", time: "04:00", weekday: 0, day: 1 },
    geekbench5: { enabled: true, frequency: "weekly", time: "04:30", weekday: 0, day: 1 },
  },
});

const COMMAND_PREFIX = String.raw`set -u
export LC_ALL=C
TEST_NAME="__TEST__"
LOCK_DIR=/var/tmp/komari-benchmark.lock
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "KMB_TEST=$TEST_NAME"
  echo "KMB_STATUS=busy"
  echo "KMB_ERROR=benchmark already running"
  exit 0
fi
cleanup_benchmark() {
  rm -f "$LOCK_DIR"/* 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup_benchmark EXIT HUP INT TERM

echo "KMB_VERSION=2"
echo "KMB_TEST=$TEST_NAME"
echo "KMB_TIME=$(date -u +%FT%TZ)"
echo "KMB_HOST_ARCH=$(uname -m)"`;

function commandFor(test, body) {
  return `${COMMAND_PREFIX.replace("__TEST__", test)}\n${body}`;
}

const SYSBENCH_COMMAND = commandFor("sysbench", String.raw`if ! command -v sysbench >/dev/null 2>&1; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: sysbench"
  exit 0
fi
THREADS=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
echo "KMB_CPU_THREADS=$THREADS"
echo "KMB_SYSBENCH_VERSION=$(sysbench --version 2>/dev/null | head -n 1)"
CPU_SINGLE=$(sysbench cpu --threads=1 --time=10 --cpu-max-prime=20000 run 2>&1 | awk '/events per second:/ { print $4; exit }')
CPU_MULTI=$(sysbench cpu --threads="$THREADS" --time=10 --cpu-max-prime=20000 run 2>&1 | awk '/events per second:/ { print $4; exit }')
if [ -z "$CPU_SINGLE" ] || [ -z "$CPU_MULTI" ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=sysbench CPU output could not be parsed"
  exit 0
fi
echo "KMB_CPU_SINGLE_EPS=$CPU_SINGLE"
echo "KMB_CPU_MULTI_EPS=$CPU_MULTI"
echo "KMB_STATUS=ok"`);

const MEMORY_COMMAND = commandFor("memory", String.raw`if ! command -v sysbench >/dev/null 2>&1; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: sysbench"
  exit 0
fi
echo "KMB_SYSBENCH_VERSION=$(sysbench --version 2>/dev/null | head -n 1)"
MEM_READ=$(sysbench memory --threads=1 --time=10 --memory-block-size=1M --memory-total-size=100T --memory-oper=read --memory-access-mode=seq run 2>&1 | awk '/transferred \(/ { gsub(/[()]/, "", $(NF-1)); print $(NF-1); exit }')
MEM_WRITE=$(sysbench memory --threads=1 --time=10 --memory-block-size=1M --memory-total-size=100T --memory-oper=write --memory-access-mode=seq run 2>&1 | awk '/transferred \(/ { gsub(/[()]/, "", $(NF-1)); print $(NF-1); exit }')
if [ -z "$MEM_READ" ] || [ -z "$MEM_WRITE" ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=sysbench memory output could not be parsed"
  exit 0
fi
echo "KMB_MEMORY_READ_MIB_S=$MEM_READ"
echo "KMB_MEMORY_WRITE_MIB_S=$MEM_WRITE"
echo "KMB_STATUS=ok"`);

const FIO_COMMAND = commandFor("fio", String.raw`if ! command -v fio >/dev/null 2>&1; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: fio"
  exit 0
fi
FREE_KB=$(df -Pk /var/tmp | awk 'NR == 2 { print $4 }')
if [ -z "$FREE_KB" ] || [ "$FREE_KB" -lt 786432 ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=less than 768 MiB free in /var/tmp"
  exit 0
fi
DATA_FILE="$LOCK_DIR/fio.bin"
JSON_FILE="$LOCK_DIR/fio.json"
cleanup_fio() {
  rm -f "$DATA_FILE" "$JSON_FILE"
  cleanup_benchmark
}
trap cleanup_fio EXIT HUP INT TERM
echo "KMB_FIO_VERSION=$(fio --version 2>/dev/null | head -n 1)"
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
echo "KMB_STATUS=ok"`);

const GEEKBENCH5_CPU_GUARD = String.raw`read_cpu_sample() {
  awk '/^cpu / { total=0; for (i=2; i<=NF; i++) total += $i; idle=$5+$6; printf "%.0f %.0f\n", total, idle; exit }' /proc/stat
}
set -- $(read_cpu_sample)
CPU_TOTAL_1=$1
CPU_IDLE_1=$2
sleep 5
set -- $(read_cpu_sample)
CPU_TOTAL_2=$1
CPU_IDLE_2=$2
CPU_TOTAL_DELTA=$((CPU_TOTAL_2 - CPU_TOTAL_1))
CPU_IDLE_DELTA=$((CPU_IDLE_2 - CPU_IDLE_1))
if [ "$CPU_TOTAL_DELTA" -le 0 ]; then
  echo "KMB_STATUS=skipped"
  echo "KMB_ERROR=scheduled Geekbench 5 skipped: CPU usage could not be measured"
  exit 0
fi
CPU_USAGE=$(awk -v total="$CPU_TOTAL_DELTA" -v idle="$CPU_IDLE_DELTA" 'BEGIN { printf "%.2f", 100 * (total - idle) / total }')
echo "KMB_CPU_GUARD_USAGE=$CPU_USAGE"
if awk -v usage="$CPU_USAGE" -v threshold="${GEEKBENCH5_CPU_THRESHOLD}" 'BEGIN { exit !(usage >= threshold) }'; then
  echo "KMB_STATUS=skipped"
  echo "KMB_ERROR=scheduled Geekbench 5 skipped: CPU usage ${"$"}{CPU_USAGE}% >= ${GEEKBENCH5_CPU_THRESHOLD}%"
  exit 0
fi`;

const GEEKBENCH5_BODY = String.raw`ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)
    GB_URL="https://cdn.geekbench.com/Geekbench-5.5.1-Linux.tar.gz"
    GB_SHA256="32037e55c3dc8f360fe16b7fbb188d31387ea75980e48d8cf028330e3239c404"
    ;;
  aarch64|arm64)
    GB_URL="https://cdn.geekbench.com/Geekbench-5.5.1-LinuxARMPreview.tar.gz"
    GB_SHA256="9eb3ca9ec32abf0ebe1c64002b19108bfea53c411c6b556b0c2689514b8cbd6f"
    ;;
  *)
    echo "KMB_STATUS=unsupported"
    echo "KMB_ERROR=Geekbench 5 unsupported architecture: $ARCH"
    exit 0
    ;;
esac
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: curl or wget"
  exit 0
fi
if ! command -v sha256sum >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo "KMB_STATUS=unsupported"
  echo "KMB_ERROR=missing tools: sha256sum or tar"
  exit 0
fi
GB_ROOT=/var/tmp/komari-geekbench5-5.5.1
GB_BIN="$GB_ROOT/geekbench5"
GB_ARCHIVE="$GB_ROOT/geekbench5.tar.gz"
mkdir -p "$GB_ROOT"
if [ ! -x "$GB_BIN" ]; then
  rm -f "$GB_ARCHIVE.tmp"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 -o "$GB_ARCHIVE.tmp" "$GB_URL" >/dev/null 2>&1
  else
    wget -qO "$GB_ARCHIVE.tmp" "$GB_URL"
  fi
  if [ ! -f "$GB_ARCHIVE.tmp" ] || [ "$(sha256sum "$GB_ARCHIVE.tmp" | awk '{print $1}')" != "$GB_SHA256" ]; then
    rm -f "$GB_ARCHIVE.tmp"
    echo "KMB_STATUS=error"
    echo "KMB_ERROR=Geekbench 5 download checksum mismatch"
    exit 0
  fi
  mv "$GB_ARCHIVE.tmp" "$GB_ARCHIVE"
  tar -xzf "$GB_ARCHIVE" --strip-components=1 -C "$GB_ROOT" >/dev/null 2>&1
  if [ ! -x "$GB_BIN" ]; then
    echo "KMB_STATUS=error"
    echo "KMB_ERROR=Geekbench 5 archive could not be extracted"
    exit 0
  fi
fi
echo "KMB_GB5_VERSION=5.5.1"
GB_OUTPUT=$("$GB_BIN" --upload 2>&1)
GB_URL_RESULT=$(printf '%s\n' "$GB_OUTPUT" | grep -Eo 'https://browser\.geekbench\.com/v5/cpu/[0-9]+' | head -n 1)
if [ -z "$GB_URL_RESULT" ]; then
  echo "KMB_STATUS=error"
  echo "KMB_ERROR=Geekbench 5 did not return a public result URL"
  exit 0
fi
GB_SINGLE=""
GB_MULTI=""
GB_CSV=""
ATTEMPT=1
while [ "$ATTEMPT" -le 6 ]; do
  if command -v curl >/dev/null 2>&1; then
    GB_CSV=$(curl -fsL --connect-timeout 10 --max-time 20 "$GB_URL_RESULT.csv" 2>/dev/null || true)
  else
    GB_CSV=$(wget -qO- --timeout=20 --tries=1 "$GB_URL_RESULT.csv" 2>/dev/null || true)
  fi
  GB_SINGLE=$(printf '%s\n' "$GB_CSV" | awk -F',' '$1 == "Single-Core" { gsub(/[^0-9]/, "", $2); print $2; exit }')
  GB_MULTI=$(printf '%s\n' "$GB_CSV" | awk -F',' '$1 == "Multi-Core" { gsub(/[^0-9]/, "", $2); print $2; exit }')
  case "$GB_SINGLE:$GB_MULTI" in
    *[!0-9:]*|:|*:) ;;
    *) break ;;
  esac
  sleep $((ATTEMPT * 5))
  ATTEMPT=$((ATTEMPT + 1))
done
case "$GB_SINGLE:$GB_MULTI" in
  *[!0-9:]*|:|*:)
    if command -v curl >/dev/null 2>&1; then
      GB_PAGE=$(curl -A 'Mozilla/5.0' -fsL --connect-timeout 10 --max-time 20 "$GB_URL_RESULT" 2>/dev/null || true)
    else
      GB_PAGE=$(wget -qO- --timeout=20 --tries=1 --user-agent='Mozilla/5.0' "$GB_URL_RESULT" 2>/dev/null || true)
    fi
    GB_SCORES=$(printf '%s\n' "$GB_PAGE" | grep -Eo "<div class=['\"]score['\"]>[[:space:]]*[0-9,]+[[:space:]]*</div>" | sed -E 's/<[^>]+>//g; s/[[:space:],]//g')
    GB_SINGLE=$(printf '%s\n' "$GB_SCORES" | sed -n '1p')
    GB_MULTI=$(printf '%s\n' "$GB_SCORES" | sed -n '2p')
    ;;
esac
case "$GB_SINGLE:$GB_MULTI" in
  *[!0-9:]*|:|*:)
    echo "KMB_STATUS=error"
    echo "KMB_ERROR=Geekbench Browser scores could not be parsed"
    echo "KMB_GB5_URL=$GB_URL_RESULT"
    exit 0
    ;;
esac
echo "KMB_GB5_SINGLE=$GB_SINGLE"
echo "KMB_GB5_MULTI=$GB_MULTI"
echo "KMB_GB5_URL=$GB_URL_RESULT"
echo "KMB_STATUS=ok"`;

const GEEKBENCH5_COMMAND = commandFor("geekbench5", GEEKBENCH5_BODY);
const GEEKBENCH5_SCHEDULED_COMMAND = commandFor("geekbench5", `${GEEKBENCH5_CPU_GUARD}\n${GEEKBENCH5_BODY}`);

const BENCHMARK_COMMANDS = Object.freeze({
  sysbench: SYSBENCH_COMMAND,
  memory: MEMORY_COMMAND,
  fio: FIO_COMMAND,
  geekbench5: GEEKBENCH5_COMMAND,
});

function benchmarkCommand(test, source) {
  if (test === "geekbench5" && source === "schedule") return GEEKBENCH5_SCHEDULED_COMMAND;
  return BENCHMARK_COMMANDS[test];
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function property(object, ...names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) if (object[name] !== undefined) return object[name];
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
  const match = String(output || "").match(new RegExp(`KMB_FIO_${key}_BEGIN\\s*([\\s\\S]*?)\\s*KMB_FIO_${key}_END`));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (_) { return null; }
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

function parseBenchmarkOutput(output, exitCode, fallbackTime, expectedTest) {
  const rawOutput = String(output || "").trim();
  const agentError = rawOutput.replace(/\s+/g, " ").slice(0, 300);
  const test = extractMarker(output, "TEST") || expectedTest || "unknown";
  const status = extractMarker(output, "STATUS") || (Number(exitCode) === 0 ? "error" : "failed");
  const record = {
    test,
    time: extractMarker(output, "TIME") || fallbackTime || new Date().toISOString(),
    status,
    error: extractMarker(output, "ERROR") || (Number(exitCode) === 0 ? "" : agentError || `agent exit code ${exitCode}`),
    meta: {
      arch: extractMarker(output, "HOST_ARCH"),
      sysbench_version: extractMarker(output, "SYSBENCH_VERSION"),
      fio_version: extractMarker(output, "FIO_VERSION"),
      geekbench_version: extractMarker(output, "GB5_VERSION"),
      cpu_guard_usage: numberValue(extractMarker(output, "CPU_GUARD_USAGE")),
    },
  };
  const resultUrl = extractMarker(output, "GB5_URL");
  if (/^https:\/\/browser\.geekbench\.com\/v5\/cpu\/\d+$/.test(resultUrl)) record.result_url = resultUrl;
  if (status !== "ok") return record;

  if (test === "sysbench") {
    const single = numberValue(extractMarker(output, "CPU_SINGLE_EPS"));
    const multi = numberValue(extractMarker(output, "CPU_MULTI_EPS"));
    const threads = numberValue(extractMarker(output, "CPU_THREADS"));
    if ([single, multi, threads].some((value) => value === null)) return incomplete(record);
    record.sysbench = { cpu: { single_eps: single, multi_eps: multi, threads } };
  } else if (test === "memory") {
    const read = numberValue(extractMarker(output, "MEMORY_READ_MIB_S"));
    const write = numberValue(extractMarker(output, "MEMORY_WRITE_MIB_S"));
    if ([read, write].some((value) => value === null)) return incomplete(record);
    record.sysbench = { memory: { read_mib_s: read, write_mib_s: write } };
  } else if (test === "fio") {
    const fio = {
      "4k": parseFioResult(extractFioJSON(output, "4K")),
      "64k": parseFioResult(extractFioJSON(output, "64K")),
      "512k": parseFioResult(extractFioJSON(output, "512K")),
      "1m": parseFioResult(extractFioJSON(output, "1M")),
    };
    if (Object.values(fio).some((value) => value === null)) return incomplete(record);
    record.fio = fio;
  } else if (test === "geekbench5") {
    const single = numberValue(extractMarker(output, "GB5_SINGLE"));
    const multi = numberValue(extractMarker(output, "GB5_MULTI"));
    const url = resultUrl;
    if ([single, multi].some((value) => value === null) || !/^https:\/\/browser\.geekbench\.com\/v5\/cpu\/\d+$/.test(url)) return incomplete(record);
    record.geekbench5 = { single_score: single, multi_score: multi, url };
  } else {
    return incomplete(record);
  }
  return record;
}

function incomplete(record) {
  record.status = "error";
  record.error = "benchmark output is incomplete";
  return record;
}

function emptyHistory() {
  return { version: 2, updated_at: null, records: {} };
}

function migrateRecord(record) {
  if (!record || typeof record !== "object") return [];
  if (TEST_KEYS.includes(record.test)) return [record];
  const base = { ...record };
  delete base.sysbench;
  delete base.fio;
  const migrated = [];
  if (record.sysbench && record.sysbench.cpu) migrated.push({ ...base, test: "sysbench", sysbench: { cpu: record.sysbench.cpu } });
  if (record.sysbench && record.sysbench.memory) migrated.push({ ...base, test: "memory", sysbench: { memory: record.sysbench.memory } });
  if (record.fio) migrated.push({ ...base, test: "fio", fio: record.fio });
  if (!migrated.length) return ["sysbench", "memory", "fio"].map((test) => ({ ...base, test }));
  return migrated;
}

function normalizeHistory(value) {
  if (!value || typeof value !== "object" || !value.records || typeof value.records !== "object") return emptyHistory();
  const history = emptyHistory();
  history.updated_at = value.updated_at || null;
  for (const [uuid, records] of Object.entries(value.records)) {
    history.records[uuid] = (Array.isArray(records) ? records : []).flatMap(migrateRecord);
  }
  return history;
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

function normalizeSchedule(value, fallback) {
  const input = value && typeof value === "object" ? value : {};
  const frequency = ["daily", "weekly", "monthly"].includes(input.frequency) ? input.frequency : fallback.frequency;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time || "")) ? String(input.time) : fallback.time;
  const weekday = Math.min(6, Math.max(0, Math.trunc(numberValue(input.weekday) ?? fallback.weekday)));
  const day = Math.min(28, Math.max(1, Math.trunc(numberValue(input.day) ?? fallback.day)));
  return { enabled: input.enabled === undefined ? fallback.enabled : Boolean(input.enabled), frequency, time, weekday, day };
}

function normalizeConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  const schedules = input.schedules && typeof input.schedules === "object" ? input.schedules : {};
  const normalized = { version: 1, schedules: {} };
  for (const test of TEST_KEYS) normalized.schedules[test] = normalizeSchedule(schedules[test], DEFAULT_CONFIG.schedules[test]);
  return normalized;
}

function isScheduleDue(scheduleValue, lastRunAt, nowValue) {
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  const schedule = normalizeSchedule(scheduleValue, DEFAULT_CONFIG.schedules.sysbench);
  if (!schedule.enabled || !Number.isFinite(now.getTime())) return false;
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (now.getHours() !== hour || now.getMinutes() !== minute) return false;
  if (schedule.frequency === "weekly" && now.getDay() !== schedule.weekday) return false;
  if (schedule.frequency === "monthly" && now.getDate() !== schedule.day) return false;
  const last = new Date(lastRunAt || 0);
  return !Number.isFinite(last.getTime())
    || last.getFullYear() !== now.getFullYear()
    || last.getMonth() !== now.getMonth()
    || last.getDate() !== now.getDate();
}

function dueTests(configValue, stateValue, now) {
  const config = normalizeConfig(configValue);
  const state = stateValue && typeof stateValue === "object" ? stateValue : {};
  return TEST_KEYS.filter((test) => isScheduleDue(config.schedules[test], state[test], now));
}

module.exports = {
  BENCHMARK_COMMANDS,
  DEFAULT_CONFIG,
  GEEKBENCH5_CPU_THRESHOLD,
  POLL_INTERVAL_MS,
  RETENTION_DAYS,
  SCHEDULER_TICK,
  TASK_TIMEOUT_MS,
  TEST_KEYS,
  benchmarkCommand,
  clientInfo,
  dueTests,
  emptyHistory,
  historyForNode,
  isScheduleDue,
  mergeHistory,
  normalizeConfig,
  normalizeHistory,
  parseBenchmarkOutput,
  parseFioResult,
  property,
  taskResultFinished,
};
