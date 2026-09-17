// Seeds a Cache from the design fixtures, so the browser dev server and the
// tests render the same inbox the mock does. The only place the desktop app
// imports fixture data for mail.

import type { Brief, Draft, Group, Message, SectionRule, Tag, Thread } from "@monday/shared";
import * as fixtures from "@monday/ui/fixtures";
import type { Statement } from "./driver.ts";

export interface SeedData {
  threads: Thread[];
  messages: Message[];
  tags: Tag[];
  sections: SectionRule[];
  groups: Group[];
  briefs: Brief[];
  drafts: Draft[];
}

export function fixtureSeed(): SeedData {
  return {
    threads: fixtures.threads,
    messages: fixtures.messages,
    tags: fixtures.tags,
    sections: fixtures.sections,
    groups: fixtures.groups,
    briefs: fixtures.briefs,
    drafts: [fixtures.draft],
  };
}

/** The statements that load `data` into an empty Cache; one batch. */
export function seedStatements(data: SeedData, at = new Date().toISOString()): Statement[] {
  const out: Statement[] = [];
  for (const t of data.tags) {
    out.push({
      sql: "insert or replace into tags (id, name) values (?, ?)",
      params: [t.id, t.name],
    });
  }
  for (const s of data.sections) {
    out.push({
      sql: "insert or replace into section_rules (id, name, position, rule, hidden) values (?, ?, ?, ?, ?)",
      params: [s.id, s.name, s.order, s.rule, s.hidden],
    });
  }
  for (const g of data.groups) {
    out.push({
      sql: "insert or replace into groups (id, parent_id, name, rule, threshold) values (?, ?, ?, ?, ?)",
      params: [g.id, g.parentId, g.name, g.rule, g.threshold],
    });
  }
  for (const t of data.threads) {
    out.push({
      sql: `insert or replace into threads (id, subject, participants, last_activity, message_count, unread, starred,
              archived, deleted, snoozed_until, section, group_id, subgroup_id, has_attachments, snippet, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        t.id,
        t.subject,
        t.participants,
        t.lastActivity,
        t.messageCount,
        t.unread,
        t.starred,
        t.archived,
        false,
        t.snoozedUntil,
        t.section,
        t.group,
        t.subgroup,
        t.hasAttachments,
        t.snippet,
        at,
      ],
    });
    for (const tagId of t.tags) {
      out.push({
        sql: "insert or ignore into thread_tags (thread_id, tag_id) values (?, ?)",
        params: [t.id, tagId],
      });
    }
  }
  for (const m of data.messages) {
    out.push({
      sql: `insert or replace into messages (id, thread_id, sender, recipients, cc, date, body_text, body_html, body_at, has_attachments)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        m.id,
        m.threadId,
        m.from,
        m.to,
        m.cc,
        m.date,
        m.bodyText ?? null,
        m.bodyHtml ?? null,
        m.bodyText !== undefined ? at : null,
        m.attachments.length > 0,
      ],
    });
    for (const a of m.attachments) {
      out.push({
        sql: "insert or replace into attachments (id, message_id, name, size, media_type, text) values (?, ?, ?, ?, ?, ?)",
        params: [a.id, m.id, a.name, a.size, a.mediaType, a.text ?? null],
      });
    }
  }
  for (const b of data.briefs) {
    out.push({
      sql: "insert or replace into briefs (thread_id, bullets, actions, computed_at, stale) values (?, ?, ?, ?, ?)",
      params: [b.threadId, b.bullets, b.actions, b.computedAt, b.stale],
    });
  }
  for (const d of data.drafts) {
    out.push({
      sql: `insert or replace into drafts (id, thread_id, kind, in_reply_to_message_id, recipients, cc, bcc, subject,
              body_html, body_text, attachments, status, deleted, content_stale, updated_at, updated_by)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      params: [
        d.id,
        d.threadId,
        d.kind,
        d.inReplyToMessageId,
        d.to,
        d.cc,
        d.bcc,
        d.subject,
        d.bodyHtml,
        d.bodyText,
        d.attachments,
        d.status,
        d.updatedAt,
        d.updatedBy,
      ],
    });
  }
  return out;
}
