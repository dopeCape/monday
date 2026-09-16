// A Workflow drawn as a chain: Trigger and Step nodes joined by edges.
import { Fragment } from "react";
import { cx, uniqueKeys } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";

/** trig is a Trigger, act a Step, cond a branch. */
export type FlowNodeKind = "trig" | "act" | "cond";

export interface FlowNodeData {
  kind: FlowNodeKind;
  icon: IconComponent;
  label: string;
  /** The muted detail after the label, such as "name, role, links". */
  detail?: string | undefined;
}

export interface FlowNodeProps extends FlowNodeData {
  className?: string | undefined;
}

export function FlowNode({ kind, icon, label, detail, className }: FlowNodeProps) {
  return (
    <span className={cx("node", kind, className)}>
      <Icon icon={icon} /> {label}
      {detail ? <span className="k">{detail}</span> : null}
    </span>
  );
}

export function FlowEdge() {
  return <span className="edge" aria-hidden="true" />;
}

export interface FlowChainProps {
  nodes: readonly FlowNodeData[];
  className?: string | undefined;
}

export function FlowChain({ nodes, className }: FlowChainProps) {
  const keys = uniqueKeys(nodes.map((n) => n.label));
  return (
    <div className={cx("flow", className)}>
      {nodes.map((n, i) => (
        <Fragment key={keys[i]}>
          {i ? <FlowEdge /> : null}
          <FlowNode {...n} />
        </Fragment>
      ))}
    </div>
  );
}
