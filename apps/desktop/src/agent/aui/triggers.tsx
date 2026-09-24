// The composer's trigger menus (Assistant UI's composer trigger popover, in
// monday's CSS): / lists the slash commands from ai.composer.commands, each
// starting the message with its words, plus /new for a new Session; @ lists
// what can be mentioned, by kind, and inserts a mention the Agent reads by id.
// Both float above the bar, filter as the user types, and take the arrow
// keys, Enter and Esc from the input.

import {
  ComposerPrimitive,
  type Unstable_TriggerItem,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  useAui,
} from "@assistant-ui/react";
import { Icon } from "@monday/ui";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { ComposerStrings } from "../composerStrings.ts";
import { useComposerEnv } from "./context.tsx";
import { MENTION_ICONS, MENTION_KINDS, type MentionKind, useMentionItems } from "./mentions.tsx";

/** The built-in command; a Setting cannot take its name. */
const NEW = "new";

/** The commands as the menu lists them: the Setting's, in its order, then /new. */
export function commandList(
  commands: Readonly<Record<string, string>>,
  newLabel: string,
): { id: string; description: string; prompt: string | null }[] {
  return [
    ...Object.entries(commands)
      .filter(([id]) => id !== NEW)
      .map(([id, prompt]) => ({ id, description: prompt.trim(), prompt })),
    { id: NEW, description: newLabel, prompt: null },
  ];
}

/** The words a command starts the message with, before anything the user already typed. */
export function commandText(prompt: string, rest: string): string {
  const lead = /\s$/.test(prompt) ? prompt : `${prompt} `;
  return `${lead}${rest.trim()}`;
}

export function SlashCommands() {
  const { strings, actions } = useComposerEnv();
  const aui = useAui();
  const configured = strings["ai.composer.commands"];
  const newLabel = strings["strings.agent.command_new"];
  const commands = useMemo(
    () =>
      commandList(configured, newLabel).map((c) => ({
        id: c.id,
        description: c.description,
        execute: () => {
          if (c.prompt === null) {
            aui.composer().setText("");
            actions.newSession();
            return;
          }
          const prompt = c.prompt;
          // The menu strips "/name" first; its text lands a tick later.
          setTimeout(() => {
            const rest = aui.composer().getState().text;
            aui.composer().setText(commandText(prompt, rest));
          }, 0);
        },
      })),
    [configured, newLabel, aui, actions],
  );
  const slash = unstable_useSlashCommandAdapter({ commands, removeOnExecute: true });
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={slash.adapter}
      className="agent-menu"
      data-kind="commands"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        onExecute={slash.action.onExecute}
        removeOnExecute={slash.action.removeOnExecute}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="items">
        {(items) =>
          items.map((item, index) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              className="agent-menu-item"
            >
              <span className="name">/{item.id}</span>
              {item.description ? <span className="desc">{item.description}</span> : null}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

const KIND_LABEL = {
  thread: "strings.agent.mention.threads",
  group: "strings.agent.mention.groups",
  section: "strings.agent.mention.sections",
  person: "strings.agent.mention.people",
} as const satisfies Record<MentionKind, keyof ComposerStrings>;

const kindOf = (item: Unstable_TriggerItem): MentionKind =>
  (MENTION_KINDS as readonly string[]).includes(item.type) ? (item.type as MentionKind) : "thread";

export function Mentions() {
  const { strings } = useComposerEnv();
  const items = useMentionItems();
  const categories = useMemo(
    () =>
      MENTION_KINDS.map((kind) => ({
        id: kind,
        label: strings[KIND_LABEL[kind]],
        items: items
          .filter((i) => i.type === kind)
          .map((i) => ({
            id: i.id,
            type: i.type,
            label: i.label,
            ...(i.description ? { description: i.description } : {}),
          })),
      })).filter((c) => c.items.length > 0),
    [items, strings],
  );
  const mention = unstable_useMentionAdapter({ categories, includeModelContextTools: false });
  if (!strings["ai.composer.mentions"] || categories.length === 0) return null;
  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="@"
      adapter={mention.adapter}
      className="agent-menu"
      data-kind="mentions"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={mention.directive.formatter}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverCategories className="items">
        {(list) =>
          list.map((c) => (
            <ComposerPrimitive.Unstable_TriggerPopoverCategoryItem
              key={c.id}
              categoryId={c.id}
              className="agent-menu-item"
            >
              <Icon icon={MENTION_ICONS[c.id as MentionKind] ?? CaretRightIcon} />
              <span className="name">{c.label}</span>
              <Icon icon={CaretRightIcon} className="more" />
            </ComposerPrimitive.Unstable_TriggerPopoverCategoryItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverCategories>
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="items">
        {(list) => (
          <>
            <ComposerPrimitive.Unstable_TriggerPopoverBack className="agent-menu-back">
              <Icon icon={CaretLeftIcon} />
              {strings["strings.agent.mention.back"]}
            </ComposerPrimitive.Unstable_TriggerPopoverBack>
            {list.map((item, index) => (
              <ComposerPrimitive.Unstable_TriggerPopoverItem
                key={`${item.type}:${item.id}`}
                item={item}
                index={index}
                className="agent-menu-item"
              >
                <Icon icon={MENTION_ICONS[kindOf(item)]} />
                <span className="name">{item.label}</span>
                {item.description ? <span className="desc">{item.description}</span> : null}
              </ComposerPrimitive.Unstable_TriggerPopoverItem>
            ))}
          </>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
