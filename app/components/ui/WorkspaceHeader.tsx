import type { ReactNode } from "react";

export interface WorkspaceHeaderMetric {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: "blue" | "violet" | "aqua" | "green" | "amber";
}

export function WorkspaceHeader({
  eyebrow,
  title,
  detail,
  icon,
  metrics = [],
  actions,
  className = "",
}: {
  eyebrow: string;
  title: string;
  detail: string;
  icon: ReactNode;
  metrics?: WorkspaceHeaderMetric[];
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`workspace-view-header ${className}`.trim()}>
      <div className="workspace-view-intro">
        <span className="workspace-view-icon" aria-hidden="true">{icon}</span>
        <div className="workspace-view-copy">
          <p className="workspace-view-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="workspace-view-detail">{detail}</p>
        </div>
      </div>

      {actions ? <div className="workspace-view-actions">{actions}</div> : null}

      {metrics.length ? (
        <dl className="workspace-view-metrics">
          {metrics.map((metric) => (
            <div className={`workspace-view-metric is-${metric.tone ?? "blue"}`} key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
              {metric.detail ? <small>{metric.detail}</small> : null}
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}
