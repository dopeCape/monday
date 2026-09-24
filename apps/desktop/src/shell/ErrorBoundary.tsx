// A crash in one part of the app stays in that part. Without a boundary React
// unmounts the whole tree on a render error and the window goes blank; with
// one, the part that failed says so in plain words with Reload, and the rest
// keeps working. The words are the schema's defaults: the Shell that holds the
// user's Settings may be what failed.

import { defaultSettings } from "@monday/shared";
import { Btn } from "@monday/ui";
import { Component, type ErrorInfo, type ReactNode } from "react";

const defaults = defaultSettings();

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Where the boundary sits, for the log line and the fallback's data-area. */
  area: string;
  /** Smaller fallback for a panel (the Agent) than for the whole window. */
  compact?: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[monday] ${this.props.area} crashed:`, error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className={this.props.compact ? "crash compact" : "crash"}
        role="alert"
        data-area={this.props.area}
      >
        <b>{defaults["strings.crash.title"]}</b>
        <span className="crash-detail">{error.message}</span>
        <div className="crash-actions">
          {this.props.compact ? (
            <Btn sm onClick={() => this.setState({ error: null })}>
              {defaults["strings.crash.retry"]}
            </Btn>
          ) : null}
          <Btn sm primary onClick={() => window.location.reload()}>
            {defaults["strings.crash.reload"]}
          </Btn>
        </div>
      </div>
    );
  }
}
