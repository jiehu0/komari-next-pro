import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
export type CloudOrder = { revision: number; grid: string[]; table: string[]; follow: boolean };
const endpoint = "/api/plugin/komari-layout/order";
export function useCloudOrder() {
  const [state, setState] = useState<CloudOrder | null>(null);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const mounted = useRef(true);
  const accept = (next: CloudOrder) => setState(old => !old || next.revision >= old.revision ? next : old);
  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      if (saving.current || document.hidden) return;
      try {
        const [response, account] = await Promise.all([fetch(endpoint, { cache: "no-store", credentials: "include" }), fetch("/api/me", { cache: "no-store", credentials: "include" })]);
        if (!response.ok) throw new Error("云端排序暂不可用");
        const data = await response.json();
        const me = await account.json();
        if (mounted.current && !saving.current) { accept(data); setAdmin(me?.logged_in === true); setError(""); }
      } catch (e) { if (mounted.current) { setError(e instanceof Error ? e.message : "同步失败"); setAdmin(false); } }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const save = async (kind: "grid" | "table" | "follow", value: string[] | boolean) => {
    if (!state || !admin || saving.current) return;
    const previous = state;
    const optimistic = { ...state };
    if (kind === "follow") {
      optimistic.follow = value as boolean;
    } else {
      const ordered = value as string[];
      const selected = new Set(ordered);
      let i = 0;
      optimistic[kind] = state[kind].map(id => selected.has(id) ? ordered[i++] : id);
    }
    saving.current = true; setBusy(true); setState(optimistic);
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: state.revision, kind, value }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message || "保存失败");
      if (mounted.current) accept(next);
    } catch (e) { if (mounted.current) setState(previous); toast.error(e instanceof Error ? e.message : "保存失败"); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  return { state, admin, busy, error, save };
}
