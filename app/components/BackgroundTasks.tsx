"use client";

import { CheckCircle2, ChevronUp, CircleAlert, LoaderCircle, ListChecks, X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type TaskStatus = "running" | "complete" | "error";

/** One recorded moment inside a task: what happened, and when. */
export interface TaskStep {
  at: number;
  message: string;
  tone?: "info" | "warn" | "error";
}

interface BackgroundTask {
  id: string;
  /** Stable identity used to prevent the same operation from running twice. */
  key?: string;
  label: string;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  detail?: string;
  /** The task's own progress trail, newest last. */
  steps?: TaskStep[];
}

interface BackgroundTaskOptions {
  key?: string;
}

/**
 * What a running operation can report about itself.
 *
 * Passed to every `runTask` callback so a multi-step job (resolve an identifier,
 * fetch metadata, download a PDF, save the record) leaves a trail explaining where
 * it got to, instead of collapsing to one line on failure.
 */
export interface TaskLogger {
  step: (message: string, tone?: TaskStep["tone"]) => void;
}

interface BackgroundTaskContextValue {
  runTask: <Result>(label: string, operation: (log: TaskLogger) => Promise<Result>, options?: BackgroundTaskOptions) => Promise<Result>;
  tasks: BackgroundTask[];
  open: boolean;
  setOpen: (open: boolean) => void;
  dismissTask: (id: string) => void;
  clearFinished: () => void;
}

const BackgroundTaskContext = createContext<BackgroundTaskContextValue | null>(null);
const TASK_HISTORY_KEY = "stacks-activity-log-v1";

/** Remove terminal formatting/control bytes from CLI and Playwright failures. */
export function cleanTaskText(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function readTaskHistory(): BackgroundTask[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(TASK_HISTORY_KEY) || "[]") as BackgroundTask[];
    return Array.isArray(parsed) ? parsed.slice(0, 40).map((task) => task.status === "running"
      ? { ...task, status: "error", completedAt: Date.now(), detail: "Stopped when the app closed." }
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
  const activeTaskKeys = useRef(new Set<string>());

  useEffect(() => {
    window.sessionStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(tasks));
  }, [tasks]);

  const runTask = useCallback(async <Result,>(label: string, operation: (log: TaskLogger) => Promise<Result>, options?: BackgroundTaskOptions): Promise<Result> => {
    const key = options?.key?.trim();
    if (key && activeTaskKeys.current.has(key)) {
      throw new Error(`${label} is already running.`);
    }
    if (key) activeTaskKeys.current.add(key);
    const id = crypto.randomUUID();
    const task: BackgroundTask = { id, key, label, status: "running", startedAt: Date.now(), steps: [] };
    setTasks((current) => {
      const next = [task, ...current];
      let finishedKept = 0;
      // Running work must remain observable even when the history is busy; cap
      // only completed/error rows so their owning controls stay disabled.
      return next.filter((entry) => entry.status === "running" || finishedKept++ < 40);
    });
    const append = (step: TaskStep) => {
      setTasks((current) => current.map((entry) => entry.id === id
        // Capped: a long import should not grow the log without bound.
        ? { ...entry, steps: [...(entry.steps ?? []), step].slice(-30) }
        : entry));
    };
    const log: TaskLogger = { step: (message, tone) => append({ at: Date.now(), message: cleanTaskText(message), tone }) };
    try {
      const result = await operation(log);
      setTasks((current) => current.map((entry) => entry.id === id ? { ...entry, status: "complete", completedAt: Date.now() } : entry));
      return result;
    } catch (error) {
      const detail = cleanTaskText(error instanceof Error ? error.message : "The task failed.");
      // The failure is recorded as a step too, so the trail reads in order right up
      // to what went wrong.
      append({ at: Date.now(), message: detail, tone: "error" });
      setTasks((current) => current.map((entry) => entry.id === id ? { ...entry, status: "error", detail, completedAt: Date.now() } : entry));
      setOpen(true);
      throw error;
    } finally {
      if (key) activeTaskKeys.current.delete(key);
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

/** A task's recorded steps, shown under it once expanded. */
function TaskStepList({ steps }: { steps: TaskStep[] }) {
  return (
    <ol className="background-task-steps">
      {steps.map((step, index) => (
        <li key={`${step.at}-${index}`} className={step.tone ? `is-${step.tone}` : undefined}>
          <time>{new Date(step.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
          <span>{step.message}</span>
        </li>
      ))}
    </ol>
  );
}

export function BackgroundTaskDock() {
  const { tasks, open, setOpen, dismissTask, clearFinished } = useBackgroundTasks();
  const running = tasks.filter((task) => task.status === "running").length;
  // Which tasks have their step trail open. Failures start expanded, because that is
  // when the detail is the reason the user opened the log at all.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isExpanded = (task: BackgroundTask) => expanded[task.id] ?? task.status === "error";
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
                <span>
                  <strong>{task.label}</strong>
                  <small>{task.status === "running" ? "Running" : task.status === "complete" ? "Completed" : "Failed"} · {new Date(task.completedAt ?? task.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>
                  {task.steps?.length ? (
                    <>
                      <button
                        type="button"
                        className="background-task-steps-toggle"
                        aria-expanded={isExpanded(task)}
                        onClick={() => setExpanded((current) => ({ ...current, [task.id]: !isExpanded(task) }))}
                      >
                        {isExpanded(task) ? "Hide details" : `Show ${task.steps.length} step${task.steps.length === 1 ? "" : "s"}`}
                      </button>
                      {isExpanded(task) ? <TaskStepList steps={task.steps} /> : null}
                    </>
                  ) : null}
                </span>
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
