"use client";

import { CheckCircle2, ChevronUp, CircleAlert, LoaderCircle, ListChecks, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

type TaskStatus = "running" | "complete" | "error";

interface BackgroundTask {
  id: string;
  label: string;
  status: TaskStatus;
  startedAt: number;
  detail?: string;
}

interface BackgroundTaskContextValue {
  runTask: <Result>(label: string, operation: () => Promise<Result>) => Promise<Result>;
  tasks: BackgroundTask[];
  open: boolean;
  setOpen: (open: boolean) => void;
  dismissTask: (id: string) => void;
}

const BackgroundTaskContext = createContext<BackgroundTaskContextValue | null>(null);

export function useBackgroundTasks(): BackgroundTaskContextValue {
  const context = useContext(BackgroundTaskContext);
  if (!context) {
    throw new Error("useBackgroundTasks must be used inside BackgroundTaskProvider.");
  }
  return context;
}

export function BackgroundTaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [open, setOpen] = useState(false);

  const runTask = useCallback(async <Result,>(label: string, operation: () => Promise<Result>): Promise<Result> => {
    const id = crypto.randomUUID();
    const task: BackgroundTask = { id, label, status: "running", startedAt: Date.now() };
    setTasks((current) => [task, ...current].slice(0, 12));
    try {
      const result = await operation();
      setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "complete" } : task));
      window.setTimeout(() => {
        setTasks((current) => current.filter((task) => task.id !== id));
      }, 6000);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The background operation failed.";
      setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "error", detail } : task));
      setOpen(true);
      throw error;
    }
  }, []);

  const dismissTask = useCallback((id: string) => {
    setTasks((current) => current.filter((task) => task.id !== id));
  }, []);
  const value = useMemo(() => ({ runTask, tasks, open, setOpen, dismissTask }), [dismissTask, open, runTask, tasks]);

  return (
    <BackgroundTaskContext.Provider value={value}>
      {children}
    </BackgroundTaskContext.Provider>
  );
}

export function BackgroundTaskDock() {
  const { tasks, open, setOpen, dismissTask } = useBackgroundTasks();
  const running = tasks.filter((task) => task.status === "running").length;
  if (!tasks.length) {
    return null;
  }
  return (
    <aside className={`background-task-dock ${open ? "is-open" : ""}`} aria-label="Background tasks">
      {open ? (
        <div className="background-task-panel">
          <header>
            <span><ListChecks size={16} /><strong>Background tasks</strong></span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Collapse background tasks"><X size={15} /></button>
          </header>
          <div className="background-task-list">
            {tasks.map((task) => (
              <div className={`background-task-row is-${task.status}`} key={task.id}>
                {task.status === "running" ? <LoaderCircle className="spin" size={16} /> : task.status === "complete" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
                <span><strong>{task.label}</strong>{task.detail ? <small>{task.detail}</small> : <small>{task.status === "running" ? "Running in the background" : task.status === "complete" ? "Completed" : "Needs attention"}</small>}</span>
                {task.status !== "running" ? <button type="button" onClick={() => dismissTask(task.id)} aria-label={`Dismiss ${task.label}`}><X size={13} /></button> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="background-task-trigger" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <LoaderCircle className="spin" size={17} /> : <ListChecks size={17} />}
        <span>{running ? `${running} running` : "Tasks"}</span>
        <ChevronUp size={14} />
      </button>
    </aside>
  );
}
