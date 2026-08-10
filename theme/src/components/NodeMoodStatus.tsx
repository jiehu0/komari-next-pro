"use client";

import React, { useEffect, useMemo, useState } from "react";

type RecentRecord = {
  cpu?: { usage?: number };
  ram?: { used?: number; total?: number };
};

type LoadAverage = {
  cpu: number;
  memory: number;
};

const LEVELS = [
  { minDays: 0, name: "Lv1", title: "新生", className: "ds-mood-level-1" },
  { minDays: 7, name: "Lv2", title: "幼苗", className: "ds-mood-level-2" },
  { minDays: 30, name: "Lv3", title: "成长", className: "ds-mood-level-3" },
  { minDays: 90, name: "Lv4", title: "茁壮", className: "ds-mood-level-4" },
  { minDays: 180, name: "Lv5", title: "老将", className: "ds-mood-level-5" },
  { minDays: 365, name: "Lv6", title: "传说", className: "ds-mood-level-6" },
] as const;

export function getNodeMood(cpu: number, memory: number, online: boolean) {
  if (!online) return { emoji: "💀", label: "离线" };
  if (cpu > 90 || memory > 95) return { emoji: "😰", label: "危险" };
  if (cpu > 80 || memory > 85) return { emoji: "😰", label: "紧张" };
  if (cpu > 50 || memory > 70) return { emoji: "😤", label: "忙碌" };
  if (cpu > 15 || memory > 40) return { emoji: "😊", label: "正常" };
  if (cpu > 3 || memory > 20) return { emoji: "😌", label: "悠闲" };
  return { emoji: "😴", label: "睡觉" };
}

export function getNodeLevel(uptimeSeconds: number) {
  const days = Math.max(0, Math.floor((uptimeSeconds || 0) / 86400));
  let index = LEVELS.length - 1;
  while (index > 0 && days < LEVELS[index].minDays) index -= 1;
  const level = LEVELS[index];
  const next = LEVELS[index + 1];
  const progress = next
    ? Math.min(100, ((days - level.minDays) / (next.minDays - level.minDays)) * 100)
    : 100;
  const title = next
    ? `${level.name} ${level.title} · ${days}天 · 下一级：${next.title}（${next.minDays}天）`
    : `${level.name} ${level.title} · ${days}天`;
  return { ...level, days, progress, tooltip: title };
}

function averageRecentRecords(records: RecentRecord[], fallbackMemoryTotal: number): LoadAverage | null {
  let cpuTotal = 0;
  let memoryTotal = 0;
  let count = 0;

  for (const record of records) {
    const cpu = Number(record?.cpu?.usage);
    const used = Number(record?.ram?.used);
    const total = Number(record?.ram?.total) || fallbackMemoryTotal;
    if (!Number.isFinite(cpu) || !Number.isFinite(used) || !Number.isFinite(total) || total <= 0) continue;
    cpuTotal += cpu;
    memoryTotal += (used / total) * 100;
    count += 1;
  }

  return count > 0 ? { cpu: cpuTotal / count, memory: memoryTotal / count } : null;
}

interface NodeMoodStatusProps {
  uuid: string;
  online: boolean;
  uptime: number;
  memoryTotal: number;
  currentCpu: number;
  currentMemory: number;
  showMood: boolean;
  showLevel: boolean;
}

export default function NodeMoodStatus({
  uuid,
  online,
  uptime,
  memoryTotal,
  currentCpu,
  currentMemory,
  showMood,
  showLevel,
}: NodeMoodStatusProps) {
  const [average, setAverage] = useState<LoadAverage | null>(null);

  useEffect(() => {
    if (!showMood || !online || !uuid) return;
    let active = true;

    const load = () => {
      fetch(`/api/recent/${encodeURIComponent(uuid)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!active) return;
          const records = Array.isArray(payload?.data) ? payload.data : [];
          setAverage(averageRecentRecords(records, memoryTotal));
        })
        .catch(() => {
          if (active) setAverage(null);
        });
    };

    load();
    const timer = window.setInterval(load, 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [memoryTotal, online, showMood, uuid]);

  const load = average ?? { cpu: currentCpu, memory: currentMemory };
  const mood = useMemo(() => getNodeMood(load.cpu, load.memory, online), [load.cpu, load.memory, online]);
  const level = useMemo(() => getNodeLevel(uptime), [uptime]);

  if (!showMood && !showLevel) return null;

  return (
    <div className="ds-mood-row">
      {showMood ? (
        <span
          className="ds-mood-emoji"
          title={`${mood.label} · CPU ${load.cpu.toFixed(1)}% / 内存 ${load.memory.toFixed(1)}%`}
          aria-label={`节点状态：${mood.label}`}
        >
          {mood.emoji}
        </span>
      ) : null}
      {showLevel ? (
        <>
          <span className={`ds-mood-level ${level.className}`} title={level.tooltip}>{level.name}</span>
          <span className="ds-mood-progress" title={level.tooltip}>
            <span className="ds-mood-progress-fill" style={{ width: `${level.progress}%` }} />
          </span>
        </>
      ) : null}
    </div>
  );
}
