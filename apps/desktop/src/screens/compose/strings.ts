// Every word the compose surfaces show, read from the Settings so the Agent
// can change them (inbox.md, "Strings").

import type { Settings } from "@monday/shared";
import type { EditorStrings } from "./Editor.tsx";
import type { ReplyStrings } from "./reply.ts";
import type { UndoBarStrings } from "./UndoBar.tsx";

export interface ComposeUiStrings {
  overlay: {
    newMessage: string;
    reply: string;
    forward: string;
    to: string;
    cc: string;
    bcc: string;
    subject: string;
    send: string;
    later: string;
    attach: string;
    formatting: string;
    rewrite: string;
    close: string;
    minimize: string;
    discard: string;
    assist: string;
    bold: string;
    italic: string;
    link: string;
    bullets: string;
    numbered: string;
    quote: string;
    clearFormat: string;
  };
  dock: {
    label: string;
    more: string;
    restore: string;
    close: string;
    unsaved: string;
    noRecipient: string;
    replyOn: string;
    noSubject: string;
  };
  discarded: string;
  draftedByAgent: string;
  draftedByYou: string;
  openDraft: string;
  assist: AssistStrings;
  laterIn: string;
  laterOne: string;
  discard: string;
  saved: string;
  saving: string;
  replyTo: string;
  replyAll: string;
  replyOne: string;
  forwardAttachments: string;
  draftReply: string;
  uploading: string;
  removeAttachment: string;
  noRecipients: string;
  editor: EditorStrings;
  reply: ReplyStrings;
  undo: UndoBarStrings;
  sendCancelled: string;
  sendFailed: string;
  tooLarge: string;
  scheduled: { title: string; empty: string; cancel: string; to: string; noSubject: string };
}

export interface AssistStrings {
  menu: string;
  onSelection: string;
  onBody: string;
  shorter: string;
  clearer: string;
  friendlier: string;
  formal: string;
  grammar: string;
  translate: string;
  continueWriting: string;
  instruction: string;
  voice: string;
  working: string;
  failed: string;
  noRuntime: string;
  suggestion: string;
  accept: string;
  reject: string;
}

export function composeStrings(s: Settings): ComposeUiStrings {
  return {
    overlay: {
      newMessage: s["strings.compose.new"],
      reply: s["strings.compose.reply"],
      forward: s["strings.compose.forward"],
      to: s["strings.compose.to"],
      cc: s["strings.compose.cc"],
      bcc: s["strings.compose.bcc"],
      subject: s["strings.compose.subject"],
      send: s["strings.compose.send"],
      later: s["strings.compose.later"],
      attach: s["strings.compose.attach"],
      formatting: s["strings.compose.formatting"],
      rewrite: s["strings.compose.rewrite"],
      close: s["strings.compose.close"],
      minimize: s["strings.compose.minimize"],
      discard: s["strings.compose.discard"],
      assist: s["strings.compose.assist"],
      bold: s["strings.compose.bold"],
      italic: s["strings.compose.italic"],
      link: s["strings.compose.link"],
      bullets: s["strings.compose.bullets"],
      numbered: s["strings.compose.numbered"],
      quote: s["strings.compose.quote"],
      clearFormat: s["strings.compose.clear_format"],
    },
    dock: {
      label: s["strings.compose.dock"],
      more: s["strings.compose.dock_more"],
      restore: s["strings.compose.restore"],
      close: s["strings.compose.close_draft"],
      unsaved: s["strings.compose.unsaved"],
      noRecipient: s["strings.compose.no_recipient"],
      replyOn: s["strings.compose.reply_on"],
      noSubject: s["strings.compose.no_subject"],
    },
    discarded: s["strings.compose.discarded"],
    draftedByAgent: s["strings.compose.drafted_by_agent"],
    draftedByYou: s["strings.compose.drafted_by_you"],
    openDraft: s["strings.compose.open_draft"],
    assist: {
      menu: s["strings.compose.assist"],
      onSelection: s["strings.compose.assist_on_selection"],
      onBody: s["strings.compose.assist_on_body"],
      shorter: s["strings.compose.assist_shorter"],
      clearer: s["strings.compose.assist_clearer"],
      friendlier: s["strings.compose.assist_friendlier"],
      formal: s["strings.compose.assist_formal"],
      grammar: s["strings.compose.assist_grammar"],
      translate: s["strings.compose.assist_translate"],
      continueWriting: s["strings.compose.assist_continue"],
      instruction: s["strings.compose.assist_instruction"],
      voice: s["strings.compose.assist_voice"],
      working: s["strings.compose.assist_working"],
      failed: s["strings.compose.assist_failed"],
      noRuntime: s["strings.compose.assist_no_runtime"],
      suggestion: s["strings.compose.suggestion"],
      accept: s["strings.compose.accept"],
      reject: s["strings.compose.reject"],
    },
    laterIn: s["strings.compose.later_in"],
    laterOne: s["strings.compose.later_one"],
    discard: s["strings.compose.discard"],
    saved: s["strings.compose.saved"],
    saving: s["strings.compose.saving"],
    replyTo: s["strings.compose.reply_to"],
    replyAll: s["strings.compose.reply_all"],
    replyOne: s["strings.compose.reply_one"],
    forwardAttachments: s["strings.compose.forward_attachments"],
    draftReply: s["strings.compose.draft_reply"],
    uploading: s["strings.compose.uploading"],
    removeAttachment: s["strings.compose.remove_attachment"],
    noRecipients: s["strings.send.no_recipients"],
    editor: {
      bold: s["strings.compose.bold"],
      italic: s["strings.compose.italic"],
      bullets: s["strings.compose.bullets"],
      numbered: s["strings.compose.numbered"],
      link: s["strings.compose.link"],
      linkPrompt: s["strings.compose.link_prompt"],
      quote: s["strings.compose.quote"],
      code: s["strings.compose.code"],
      clearFormat: s["strings.compose.clear_format"],
      quoted: s["strings.reader.show_quoted"],
    },
    reply: { wrote: s["strings.compose.wrote"], forwarded: s["strings.compose.forwarded"] },
    undo: {
      sendingIn: s["strings.send.sending_in"],
      sendingNow: s["strings.send.sending_now"],
      scheduledFor: s["strings.send.scheduled_for"],
      undo: s["strings.inbox.undo"],
    },
    sendCancelled: s["strings.send.undone"],
    sendFailed: s["strings.send.failed"],
    tooLarge: s["strings.send.too_large"],
    scheduled: {
      title: s["strings.scheduled.title"],
      empty: s["strings.scheduled.empty"],
      cancel: s["strings.scheduled.cancel"],
      to: s["strings.scheduled.to"],
      noSubject: s["strings.compose.no_subject"],
    },
  };
}
