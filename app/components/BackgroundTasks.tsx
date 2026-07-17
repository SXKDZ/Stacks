"use client";

import { CheckCircle2, ChevronUp, CircleAlert, LoaderCircle, ListChecks, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

type TaskStatus = "running" | "complete" | "error";

interface BackgroundTask {
  id: string;
  label: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  detail?: string;
}

interface BackgroundTaskContextValue {
  runTask: <Result>(label: string, operation: () => Promise<Result>) => Promise<Result>;
  tasks: BackgroundTask[];
  open: boolean;
  setOpen: (open: boolean) => void;
  dismissTask: (id: string) => void;
  clearFinished: () => void;
}

const BackgroundTaskContext = createContext<BackgroundTaskContextValue | null>(null);
const TASK_HISTORY_KEY = "pa-activity-log-v1";

function readTaskHistory(): BackgroundTask[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(TASK_HISTORY_KEY) || "[]") as BackgroundTask[];
    return Array.isArray(parsed) ? parsed.slice(0, 40).map((task) => task.status === "running"
      ? { ...task, status: "error", completedAt: Date.now(), detail: "Interrupted when the app session ended." }
      : task) : [];
  } catch {
    return [];
  }
}

export function useBackgroundTasks(): BackgroundTaskContextValue {
  const context = useContext(BackgroundTaskContext);
  if (!context) {
    throw new Error("useBackgroundTasks must be used inside BackgroundTaskProvider.");
  }
  return context;
}

export function BackgroundTaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>(readTaskHistory);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    window.sessionStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(tasks));
  }, [tasks]);

  const runTask = useCallback(async <Result,>(label: string, operation: () => Promise<Result>): Promise<Result> => {
    const id = crypto.randomUUID();
    const task: BackgroundTask = { id, label, status: "running", startedAt: Date.now() };
    setTasks((current) => [task, ...current].slice(0, 40));
    try {
      const result = await operation();
      setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "complete", completedAt: Date.now() } : task));
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The background operation failed.";
      setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "error", detail, completedAt: Date.now() } : task));
      setOpen(true);
      throw error;
    }
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);
  const clearFinished = useCallback(() => {
    setTasks((current) => current.filter((task) => task.status === "running"));
  }, []);
  const value = useMemo(() => ({ runTask, tasks, open, setOpen, dismissTask, clearFinished }), [clearFinished, dismissTask, open, runTask, tasks]);

  return (
    <BackgroundTaskContext.Provider value={value}>
      {children}
    </BackgroundTaskContext.Provider>
  );
}

export function BackgroundTaskDock() {
  const { tasks, open, setOpen, dismissTask, clearFinished } = useBackgroundTasks();
  const running = tasks.filter((task) => task.status === "running").length;
  return (
    <aside className={`background-task-dock ${open ? "is-open" : ""}`} aria-label="Activity log">
      {open ? (
        <div className="background-task-panel">
          <header>
            <span><ListChecks size={16} /><strong>Activity log</strong></span>
            <div><button type="button" className="activity-clear" onClick={clearFinished} disabled={!tasks.some((task) => task.status !== "running")}>Clear finished</button><button type="button" onClick={() => setOpen(false)} aria-label="Collapse activity log"><X size={15} /></button></div>
          </header>
          <div className="background-task-list">
            {!tasks.length ? <p className="activity-log-empty">Imports, AI jobs, sync, and repairs will appear here.</p> : tasks.map((task) => (
              <div className={`background-task-row is-${task.status}`} key={task.id}>
                {task.status === "running" ? <LoaderCircle className="spin" size={16} /> : task.status === "complete" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                <span><strong>{task.label}</strong><small title={task.detail}>{task.detail || (task.status === "running" ? "Running" : task.status === "complete" ? "Completed" : "Needs attention")} · {new Date(task.completedAt ?? task.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></span>
                {task.status !== "running" ? <button type="button" onClick={() => dismissTask(task.id)} aria-label={`Dismiss ${task.label}`}><X size={13} /></button> : null}
            </div>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="background-task-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <LoaderCircle className="spin" size={17} /> : <ListChecks size={17} />}
        <span>{running ? `${running} running` : "Activity"}</span>
        <ChevronUp size={14} />
      </button>
    </aside>
  );
}
