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
  };
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
