// The writing assist: one menu on the toolbar (shorter, clearer, friendlier,
// more formal, fix grammar, translate, continue writing, and a free
// instruction) over the selection or, without one, the user's own text. The
// answer comes back as a suggestion beside the text with Accept and Reject;
// nothing is written into the Draft until the user accepts (ADR 0002's spirit
// for a model's words). Shown only when the Setting is on, the AI level is not
// off and the Server says a runtime can answer; each run is metered there.

import type { DraftAssistAction } from "@monday/shared";
import { Btn, Icon, Mark } from "@monday/ui";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Composer } from "./composer.ts";
import { type AssistTarget, applySuggestion, assistTarget } from "./Editor.tsx";
import { AnchoredMenu } from "./Menu.tsx";
import type { AssistStrings } from "./strings.ts";

export type Suggestion =
  | { status: "working"; action: DraftAssistAction }
  | { status: "ready"; action: DraftAssistAction; text: string; voice: boolean }
  | { status: "failed"; action: DraftAssistAction; error: string };

export interface AssistState {
  /** The Server can answer: the button shows. */
  available: boolean;
  suggestion: Suggestion | null;
  run(
    action: DraftAssistAction,
    options?: { instruction?: string | undefined; language?: string | undefined },
  ): void;
  accept(): void;
  reject(): void;
}

export interface UseAssistOptions {
  composer: Composer;
  draftId: string;
  editor: TiptapEditor | null;
  /** The Setting and the AI level allow it. */
  enabled: boolean;
  subject: string;
  to: readonly string[];
  strings: AssistStrings;
}

export function useAssist(o: UseAssistOptions): AssistState {
  const { composer, draftId, editor, enabled, strings } = o;
  const [available, setAvailable] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const target = useRef<AssistTarget | null>(null);
  const seq = useRef(0);
  const context = useRef({ subject: o.subject, to: o.to });
  context.current = { subject: o.subject, to: o.to };

  // Asked once per window, in the background: the window never waits on it.
  useEffect(() => {
    if (!enabled || !composer.assist) {
      setAvailable(false);
      return;
    }
    let live = true;
    const probe = composer.assistAvailable?.() ?? Promise.resolve(true);
    probe.then(
      (ok) => live && setAvailable(ok),
      () => live && setAvailable(false),
    );
    return () => {
      live = false;
    };
  }, [enabled, composer]);

  const run = useCallback<AssistState["run"]>(
    (action, options = {}) => {
      if (!editor || !composer.assist) return;
      const t = assistTarget(editor);
      if (t.text.trim() === "" && action !== "continue" && action !== "instruction") return;
      target.current = t;
      seq.current += 1;
      const mine = seq.current;
      setSuggestion({ status: "working", action });
      composer
        .assist({
          draftId,
          action,
          text: t.text,
          selection: t.selection,
          ...(options.instruction ? { instruction: options.instruction } : {}),
          ...(options.language ? { language: options.language } : {}),
          subject: context.current.subject,
          to: [...context.current.to],
        })
        .then(
          (result) => {
            if (seq.current !== mine) return;
            setSuggestion({ status: "ready", action, text: result.text, voice: result.voice });
          },
          (error: unknown) => {
            if (seq.current !== mine) return;
            const message = error instanceof Error ? error.message : String(error);
            setSuggestion({
              status: "failed",
              action,
              error: /no_shared_key|ai_off/.test(message)
                ? strings.noRuntime
                : strings.failed.replace("{error}", message),
            });
          },
        );
    },
    [editor, composer, draftId, strings],
  );

  const accept = useCallback(() => {
    const s = suggestion;
    const t = target.current;
    if (!editor || !t || s?.status !== "ready") return;
    applySuggestion(editor, t, s.text, s.action === "continue" ? "append" : "replace");
    target.current = null;
    setSuggestion(null);
  }, [editor, suggestion]);

  const reject = useCallback(() => {
    seq.current += 1;
    target.current = null;
    setSuggestion(null);
    editor?.commands.focus();
  }, [editor]);

  return { available, suggestion, run, accept, reject };
}

export interface AssistMenuProps {
  assist: AssistState;
  strings: AssistStrings;
  /** The editor, whose selection (if any) is what changes: the heading says so. */
  editor: TiptapEditor | null;
  translateTo: string;
}

/** The toolbar button and its menu. */
export function AssistMenu({ assist, strings, editor, translateTo }: AssistMenuProps) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  if (!assist.available) return null;
  const selection = editor ? !editor.state.selection.empty : false;
  const items: Array<{ key: DraftAssistAction; label: string }> = [
    { key: "shorter", label: strings.shorter },
    { key: "clearer", label: strings.clearer },
    { key: "friendlier", label: strings.friendlier },
    { key: "formal", label: strings.formal },
    { key: "grammar", label: strings.grammar },
    { key: "translate", label: strings.translate.replace("{language}", translateTo) },
    { key: "continue", label: strings.continueWriting },
  ];
  return (
    <>
      <Btn
        ref={button}
        sm
        className="c-assist"
        on={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Mark small /> {strings.menu} <Icon icon={CaretDownIcon} />
      </Btn>
      {open ? (
        <AnchoredMenu
          anchor={button.current}
          label={strings.menu}
          title={selection ? strings.onSelection : strings.onBody}
          align="end"
          className="c-assist-menu"
          items={items}
          onPick={(key) => {
            setOpen(false);
            assist.run(
              key as DraftAssistAction,
              key === "translate" ? { language: translateTo } : {},
            );
          }}
          onClose={() => setOpen(false)}
        >
          <form
            className="pop-pick"
            onSubmit={(e) => {
              e.preventDefault();
              const text = instruction.trim();
              if (!text) return;
              setOpen(false);
              setInstruction("");
              assist.run("instruction", { instruction: text });
            }}
          >
            <input
              className="input"
              aria-label={strings.instruction}
              placeholder={strings.instruction}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </form>
        </AnchoredMenu>
      ) : null}
    </>
  );
}

/** The suggestion beside the text, with Accept and Reject. */
export function SuggestionPanel({
  suggestion,
  strings,
  onAccept,
  onReject,
}: {
  suggestion: Suggestion | null;
  strings: AssistStrings;
  onAccept: () => void;
  onReject: () => void;
}) {
  if (!suggestion) return null;
  return (
    <section
      className={suggestion.status === "working" ? "c-suggestion working" : "c-suggestion"}
      aria-label={strings.suggestion}
      aria-live="polite"
    >
      <div className="c-suggestion-h">
        <Mark small /> {strings.suggestion}
        {suggestion.status === "ready" && suggestion.voice ? <span>{strings.voice}</span> : null}
        <span className="sp" />
        {suggestion.status === "ready" ? (
          <Btn sm primary onClick={onAccept}>
            {strings.accept}
          </Btn>
        ) : null}
        <Btn sm onClick={onReject}>
          {strings.reject}
        </Btn>
      </div>
      {suggestion.status === "working" ? <p>{strings.working}</p> : null}
      {suggestion.status === "failed" ? <p>{suggestion.error}</p> : null}
      {suggestion.status === "ready"
        ? suggestion.text
            .split(/\n{2,}/)
            .filter((p) => p.trim() !== "")
            .map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one fixed text
              <p key={i}>{p}</p>
            ))
        : null}
    </section>
  );
}
