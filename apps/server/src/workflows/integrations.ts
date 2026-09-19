// The five integrations (slice 16; design/js/data.js, docs/spec/onboarding.md):
// Slack, Notion, Google Drive, Discord and a plain webhook, behind one seam.
// A post is what leaves the mailbox, so every call sits behind an always-ask
// tool; this module only knows how to deliver one. The HTTP implementation
// reads where to post from the workflows.integrations Setting; tests use the
// fake, which records every post.

import type { Integration } from "@monday/shared";

export type IntegrationPost =
  | { integration: "slack"; channel: string; text: string }
  | { integration: "discord"; channel: string; text: string }
  | { integration: "notion"; database: string; properties: Record<string, string> }
  | {
      integration: "drive";
      folder: string;
      name: string;
      mediaType: string;
      bytes: Uint8Array;
    }
  | {
      integration: "webhook";
      url: string;
      method: "POST" | "PUT";
      body: Record<string, unknown>;
    };

export interface IntegrationResult {
  /** The one line the Run log and the card show. */
  text: string;
  /** What the integration answered, for later Steps ({{steps.<id>.url}} and such). */
  data: Record<string, unknown>;
}

export interface Integrations {
  post(workspaceId: string, post: IntegrationPost): Promise<IntegrationResult>;
  /** Whether the integration is set up at all, for the preview's wording. */
  configured(integration: Integration): Promise<boolean>;
}

/** Where each integration posts (the workflows.integrations Setting). */
export interface IntegrationsConfig {
  slack?: { webhookUrl?: string | undefined; token?: string | undefined } | undefined;
  discord?: { webhookUrl?: string | undefined } | undefined;
  notion?: { token?: string | undefined } | undefined;
  drive?: { token?: string | undefined } | undefined;
  webhook?: { token?: string | undefined } | undefined;
}

export class IntegrationNotConfiguredError extends Error {
  constructor(readonly integration: Integration) {
    super(`${integration} is not set up; add it under Settings, Workflows, Integrations`);
    this.name = "IntegrationNotConfiguredError";
  }
}

export interface HttpIntegrationsOptions {
  config: () => Promise<IntegrationsConfig>;
  fetch?: typeof fetch;
}

/** Posts over HTTP with the endpoints and tokens the Setting holds. */
export function createHttpIntegrations(options: HttpIntegrationsOptions): Integrations {
  const doFetch = options.fetch ?? fetch;

  const send = async (
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await doFetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok)
      throw new Error(`${new URL(url).host} answered ${res.status}: ${text.slice(0, 200)}`);
    return { status: res.status, body };
  };
  const json = (body: unknown, token?: string, method = "POST"): RequestInit => ({
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  return {
    async configured(integration) {
      const c = await options.config();
      switch (integration) {
        case "slack":
          return Boolean(c.slack?.webhookUrl || c.slack?.token);
        case "discord":
          return Boolean(c.discord?.webhookUrl);
        case "notion":
          return Boolean(c.notion?.token);
        case "drive":
          return Boolean(c.drive?.token);
        case "webhook":
          return true;
      }
    },

    async post(_workspaceId, post) {
      const c = await options.config();
      switch (post.integration) {
        case "slack": {
          if (c.slack?.token) {
            const r = await send(
              "https://slack.com/api/chat.postMessage",
              json({ channel: post.channel, text: post.text }, c.slack.token),
            );
            const body = r.body as { ok?: boolean; error?: string; ts?: string } | null;
            if (!body?.ok) throw new Error(`Slack: ${body?.error ?? "not ok"}`);
            return { text: `Posted to ${post.channel}`, data: { ts: body.ts ?? null } };
          }
          if (!c.slack?.webhookUrl) throw new IntegrationNotConfiguredError("slack");
          await send(c.slack.webhookUrl, json({ text: post.text, channel: post.channel }));
          return { text: `Posted to ${post.channel}`, data: {} };
        }
        case "discord": {
          if (!c.discord?.webhookUrl) throw new IntegrationNotConfiguredError("discord");
          await send(c.discord.webhookUrl, json({ content: post.text }));
          return { text: `Posted to ${post.channel}`, data: {} };
        }
        case "notion": {
          if (!c.notion?.token) throw new IntegrationNotConfiguredError("notion");
          const properties: Record<string, unknown> = {};
          let first = true;
          for (const [key, value] of Object.entries(post.properties)) {
            properties[key] = first
              ? { title: [{ text: { content: value } }] }
              : { rich_text: [{ text: { content: value } }] };
            first = false;
          }
          const r = await send("https://api.notion.com/v1/pages", {
            ...json({ parent: { database_id: post.database }, properties }, c.notion.token),
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${c.notion.token}`,
              "notion-version": "2022-06-28",
            },
          });
          const body = r.body as { id?: string; url?: string } | null;
          return {
            text: `Row added to ${post.database}`,
            data: { id: body?.id ?? null, url: body?.url ?? null },
          };
        }
        case "drive": {
          if (!c.drive?.token) throw new IntegrationNotConfiguredError("drive");
          const boundary = `monday-${crypto.randomUUID()}`;
          const meta = JSON.stringify({ name: post.name, parents: [post.folder] });
          const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${post.mediaType}\r\n\r\n`;
          const tail = `\r\n--${boundary}--`;
          const body = new Blob([head, post.bytes, tail]);
          const r = await send(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${c.drive.token}`,
                "content-type": `multipart/related; boundary=${boundary}`,
              },
              body,
            },
          );
          const answer = r.body as { id?: string; webViewLink?: string } | null;
          return {
            text: `Saved ${post.name} to ${post.folder}`,
            data: { id: answer?.id ?? null, url: answer?.webViewLink ?? null },
          };
        }
        case "webhook": {
          const r = await send(post.url, json(post.body, c.webhook?.token, post.method));
          return {
            text: `${post.method} ${new URL(post.url).host}: ${r.status}`,
            data: { status: r.status, body: r.body },
          };
        }
      }
    },
  };
}

/* ------------------------------ Fake ------------------------------ */

export interface FakeIntegrations extends Integrations {
  posts: Array<{ workspaceId: string; post: IntegrationPost }>;
  /** Makes the next post of an integration fail with this message. */
  failNext(integration: Integration, message: string): void;
}

export function createFakeIntegrations(
  configured: readonly Integration[] = ["slack", "notion", "drive", "discord", "webhook"],
): FakeIntegrations {
  const posts: FakeIntegrations["posts"] = [];
  const failures = new Map<Integration, string>();
  return {
    posts,
    failNext(integration, message) {
      failures.set(integration, message);
    },
    async configured(integration) {
      return configured.includes(integration);
    },
    async post(workspaceId, post) {
      const failure = failures.get(post.integration);
      if (failure) {
        failures.delete(post.integration);
        throw new Error(failure);
      }
      if (!configured.includes(post.integration)) {
        throw new IntegrationNotConfiguredError(post.integration);
      }
      posts.push({ workspaceId, post });
      switch (post.integration) {
        case "slack":
        case "discord":
          return { text: `Posted to ${post.channel}`, data: { ts: String(posts.length) } };
        case "notion":
          return {
            text: `Row added to ${post.database}`,
            data: { id: `page-${posts.length}`, url: `https://notion.test/page-${posts.length}` },
          };
        case "drive":
          return {
            text: `Saved ${post.name} to ${post.folder}`,
            data: { id: `f-${posts.length}` },
          };
        case "webhook":
          return { text: `${post.method} ${new URL(post.url).host}: 200`, data: { status: 200 } };
      }
    },
  };
}
