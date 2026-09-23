// The Agent's answers as Markdown, streamed (Mosaic's streamdown-text): GFM
// tables, lists, code blocks with a copy button, inline code, links that open
// outside the app. Raw HTML in an answer is never parsed, so nothing in a
// model's output runs. Streamdown parses block by block and repairs a
// half-streamed tail, so a growing answer does not re-render its finished
// blocks or flash unclosed syntax. The icons are Phosphor; the words are
// Settings. With ai.composer.markdown off the answer is plain text.

import { MessagePartPrimitive } from "@assistant-ui/react";
import {
  StreamdownTextPrimitive,
  type StreamdownTextPrimitiveProps,
} from "@assistant-ui/react-streamdown";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsOutIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  DownloadSimpleIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ComponentProps, type ComponentType, type MouseEvent, memo, useMemo } from "react";
import { useComposerEnv } from "./context.tsx";

type IconMap = NonNullable<ComponentProps<typeof StreamdownTextPrimitive>["icons"]>;
type AnyIcon = NonNullable<IconMap[keyof IconMap]>;
const icon = (glyph: ComponentType<{ size?: number | string }>) => glyph as unknown as AnyIcon;

/** Streamdown's control icons, drawn with Phosphor like every other icon in monday. */
const ICONS: IconMap = {
  CheckIcon: icon(CheckIcon),
  CopyIcon: icon(CopyIcon),
  DownloadIcon: icon(DownloadSimpleIcon),
  ExternalLinkIcon: icon(ArrowSquareOutIcon),
  Loader2Icon: icon(CircleNotchIcon),
  Maximize2Icon: icon(ArrowsOutIcon),
  RotateCcwIcon: icon(ArrowCounterClockwiseIcon),
  XIcon: icon(XIcon),
  ZoomInIcon: icon(MagnifyingGlassPlusIcon),
  ZoomOutIcon: icon(MagnifyingGlassMinusIcon),
};

/** Copy on code and tables; no downloads, no fullscreen, no diagrams. */
const CONTROLS = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: false,
  image: false,
  // Streamdown takes the per-control objects; the wrapper's type only names the booleans.
} as unknown as StreamdownTextPrimitiveProps["controls"];

/** Only links a browser opens; anything else renders as its text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

function MarkdownText() {
  const { strings, actions } = useComposerEnv();
  const components = useMemo<StreamdownTextPrimitiveProps["components"]>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        if (!href || !SAFE_LINK.test(href)) return <span>{children}</span>;
        const open = (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          actions.openLink(href);
        };
        return (
          <a {...rest} href={href} onClick={open} rel="noreferrer" target="_blank">
            {children}
          </a>
        );
      },
    }),
    [actions],
  );
  const translations = useMemo(
    () => ({
      copyCode: strings["strings.agent.copy_code"],
      copyTable: strings["strings.agent.copy_table"],
      copied: strings["strings.agent.copied"],
    }),
    [strings],
  );
  if (!strings["ai.composer.markdown"]) {
    return <MessagePartPrimitive.Text className="agent-plain" />;
  }
  return (
    <StreamdownTextPrimitive
      containerClassName="agent-md"
      components={components}
      controls={CONTROLS}
      icons={ICONS}
      translations={translations}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
      skipHtml
      defer
    />
  );
}

export const AgentText = memo(MarkdownText);
