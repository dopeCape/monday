// Every MIME shape real Gmail hands back reaches the reader as a body: the
// adapter asks for format=raw (the whole RFC 5322 message, so the parser sees
// every part and charset the way the sender wrote them) and postal-mime turns
// it into text, html and attachments; displayBody then makes what the reader
// shows. Each case plants hand-written bytes in the fake Gmail and reads them
// back through fetchMessage.

import { describe, expect, test } from "bun:test";
import { displayBody } from "../../src/mail/index.ts";
import type { AttachmentHeader } from "../../src/mailstore/index.ts";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { createGmailProvider } from "../../src/providers/gmail/index.ts";
import { staticTokenBroker } from "../../src/providers/oauth/tokens.ts";
import type { RawMessage } from "../../src/providers/types.ts";
import { createGmailServer } from "./gmail-server.ts";

const fixture = generateFixture();

const HEAD = [
  "From: Aoife Brennan <aoife@northlight.dev>",
  "To: Tejas <tejas@example.com>",
  "Subject: Shapes",
  "Date: Mon, 14 Sep 2026 09:41:00 +0000",
  "Message-ID: <shape@northlight.dev>",
  "MIME-Version: 1.0",
];

function mime(lines: string[]): Uint8Array {
  return new TextEncoder().encode([...HEAD, ...lines].join("\r\n"));
}

/** Bytes with a latin-1 tail, for 8bit parts in a single-byte charset. */
function latin1(lines: string[], body: number[]): Uint8Array {
  const head = new TextEncoder().encode(`${[...HEAD, ...lines].join("\r\n")}\r\n\r\n`);
  return new Uint8Array([...head, ...body, 0x0d, 0x0a]);
}

const b64 = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");

// A 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function fetchThrough(bytes: Uint8Array): Promise<{ raw: RawMessage; paths: string[] }> {
  const server = createGmailServer(fixture);
  const target = [...server.emails.values()][0];
  if (!target) throw new Error("empty fixture");
  target.raw = bytes;
  const session = await createGmailProvider({
    fetch: server.fetch,
    tokens: staticTokenBroker(),
  }).connect({
    address: fixture.address,
    auth: {
      kind: "oauth",
      user: fixture.address,
      issuer: "google",
      accessToken: server.accessToken,
      refreshToken: server.refreshToken,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
    },
    endpoint: { kind: "gmail", pubsubTopic: null },
  });
  const raw = await session.fetchMessage(target.id);
  return { raw, paths: server.requests.map((r) => r.url) };
}

/** What the reader would show, with each attachment given an id the way the Mailstore does. */
function shown(raw: RawMessage, allowRemoteImages = false) {
  const headers: AttachmentHeader[] = raw.attachments.map((a, i) => ({
    id: `att-${i}`,
    messageId: "m",
    name: a.name,
    size: a.size,
    mediaType: a.mediaType,
    contentId: a.contentId,
    inline: a.inline,
  }));
  return displayBody({ text: raw.text, html: raw.html }, headers, { allowRemoteImages });
}

describe("Gmail bodies in every shape", () => {
  test("the adapter reads format=raw, never the parsed payload", async () => {
    const { paths } = await fetchThrough(
      mime(["Content-Type: text/plain; charset=utf-8", "", "hello"]),
    );
    const gets = paths.filter((p) => /\/messages\/[^/?]+\?/.test(p));
    expect(gets.length).toBeGreaterThan(0);
    for (const p of gets) expect(p).toContain("format=raw");
  });

  test("multipart/alternative: text and html, the html quoted-printable", async () => {
    const { raw } = await fetchThrough(
      mime([
        'Content-Type: multipart/alternative; boundary="alt"',
        "",
        "--alt",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64("Hi Tejas,\nThe brief is attached."),
        "--alt",
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        '<div dir=3D"ltr">Hi Tejas,<br>The <b>brief</b> is attached. Caf=C3=A9 =E2=80=94 ok=',
        "</div>",
        "--alt--",
      ]),
    );
    expect(raw.text).toBe("Hi Tejas,\nThe brief is attached.");
    expect(raw.html).toContain("The <b>brief</b> is attached. Café — ok</div>");
    expect(shown(raw).html).toBe(
      '<div dir="ltr">Hi Tejas,<br />The <b>brief</b> is attached. Café — ok</div>',
    );
  });

  test("multipart/related: the inline cid image resolves to the attachment route", async () => {
    const { raw } = await fetchThrough(
      mime([
        'Content-Type: multipart/related; boundary="rel"; type="text/html"',
        "",
        "--rel",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Chart: <img src="cid:ii_m1abc@northlight" alt="chart" width="200"></p>',
        "--rel",
        "Content-Type: image/png; name=chart.png",
        "Content-Disposition: inline; filename=chart.png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <ii_m1abc@northlight>",
        "X-Attachment-Id: ii_m1abc",
        "",
        PNG,
        "--rel--",
      ]),
    );
    expect(raw.attachments).toHaveLength(1);
    expect(raw.attachments[0]).toMatchObject({
      contentId: "ii_m1abc@northlight",
      inline: true,
      mediaType: "image/png",
    });
    expect(shown(raw).html).toBe(
      '<p>Chart: <img alt="chart" width="200" src="/attachments/att-0" /></p>',
    );
  });

  test("html only, base64, with a head and a style block", async () => {
    const { raw } = await fetchThrough(
      mime([
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64(
          '<html><head><meta charset="utf-8"><style>p { color: #333 }</style></head><body><p>Only html</p></body></html>',
        ),
      ]),
    );
    expect(raw.html).toContain("<p>Only html</p>");
    // A text alternative is made from the html for the snippet and search.
    expect(raw.text).toBe("Only html");
    expect(shown(raw).html).toBe("<style>.monday-mail p { color: #333; }</style><p>Only html</p>");
  });

  test("text only, quoted-printable with soft breaks", async () => {
    const { raw } = await fetchThrough(
      mime([
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "A long line that the sender wrapped with a soft break right here =",
        "and continued. See https://example.com/a?b=3D1",
      ]),
    );
    expect(raw.html).toBeNull();
    expect(raw.text.trim()).toBe(
      "A long line that the sender wrapped with a soft break right here and continued. See https://example.com/a?b=1",
    );
    expect(shown(raw).html).toContain('<a href="https://example.com/a?b=1"');
  });

  test("windows-1252, quoted-printable: smart quotes and the euro sign", async () => {
    const { raw } = await fetchThrough(
      mime([
        "Content-Type: text/html; charset=windows-1252",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "<p>=93Caf=E9=94 costs =80 3</p>",
      ]),
    );
    expect(shown(raw).html).toBe("<p>“Café” costs € 3</p>");
  });

  test("iso-8859-1, 8bit", async () => {
    const { raw } = await fetchThrough(
      latin1(
        ["Content-Type: text/plain; charset=ISO-8859-1", "Content-Transfer-Encoding: 8bit"],
        [0x43, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x75, 0x20, 0x6c, 0x61, 0x69, 0x74],
      ),
    );
    expect(raw.text.trim()).toBe("Café au lait");
  });

  test("nested: mixed > related > alternative, with an inline image and a PDF", async () => {
    const { raw } = await fetchThrough(
      mime([
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        'Content-Type: multipart/related; boundary="rel"',
        "",
        "--rel",
        'Content-Type: multipart/alternative; boundary="alt"',
        "",
        "--alt",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain [image: logo]",
        "--alt",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Rich <img src="cid:logo@x"></p>',
        "--alt--",
        "--rel",
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <logo@x>",
        "",
        PNG,
        "--rel--",
        "--mix",
        "Content-Type: application/pdf; name=brief.pdf",
        'Content-Disposition: attachment; filename="brief.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        b64("%PDF-1.4 fake"),
        "--mix--",
      ]),
    );
    expect(raw.text.trim()).toBe("Plain [image: logo]");
    expect(raw.attachments.map((a) => a.name)).toEqual(["attachment-1", "brief.pdf"]);
    expect(raw.attachments[0]?.contentId).toBe("logo@x");
    expect(shown(raw).html).toBe('<p>Rich <img src="/attachments/att-0" /></p>');
  });

  test("an html part the sender marked inline with a filename is still the body", async () => {
    const { raw } = await fetchThrough(
      mime([
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/html; charset=utf-8",
        "Content-Disposition: inline",
        "",
        "<p>Body marked inline</p>",
        "--mix--",
      ]),
    );
    expect(shown(raw).html).toBe("<p>Body marked inline</p>");
  });

  test("a forwarded message (message/rfc822) shows its own body", async () => {
    const { raw } = await fetchThrough(
      mime([
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "See below.",
        "--mix",
        "Content-Type: message/rfc822",
        "",
        "From: someone@example.com",
        "Subject: Original",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The original text.",
        "--mix--",
      ]),
    );
    expect(raw.text).toContain("See below.");
    expect(shown(raw).html).toContain("See below.");
  });

  test("a newsletter's remote images stay blocked until images are allowed", async () => {
    const html =
      '<table width="600" bgcolor="#ffffff"><tr><td><img src="https://cdn.example.com/hero.jpg" width="600"></td></tr></table>';
    const { raw } = await fetchThrough(
      mime(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 7bit", "", html]),
    );
    const blocked = shown(raw);
    expect(blocked.blockedImages).toBe(1);
    expect(blocked.html).toContain('data-src="https://cdn.example.com/hero.jpg"');
    const allowed = shown(raw, true);
    expect(allowed.blockedImages).toBe(0);
    expect(allowed.html).toContain('src="https://cdn.example.com/hero.jpg"');
  });
});
