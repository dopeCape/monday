// Unsubscribe (docs/spec/actions.md, "Unsubscribe"; slice 35): code only, no
// judgment. RFC 8058 one-click (a POST with List-Unsubscribe=One-Click) when
// the Message carries List-Unsubscribe-Post and an https link; else the
// mailto: address, as a Message sent through the Account; an https link
// without one-click is never fetched by monday: the chip opens it in the
// browser instead. The request reaches a third party, so it always asks
// first (ADR 0002): the card names the list and the exact request.

/** How a list is left, and where to. */
export type UnsubscribeMethod = "one_click" | "mailto" | "browser";

export interface UnsubscribePlan {
  method: UnsubscribeMethod;
  /** The https URL for one_click and browser; the address for mailto. */
  target: string;
  /** For mailto: the subject and body the list asked for, when it named them. */
  subject?: string | undefined;
  body?: string | undefined;
}

/** The <...> entries of a List-Unsubscribe header, in order. */
function entries(header: string): string[] {
  const out: string[] = [];
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const v = (m[1] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * The way out a Message's headers offer, best first: one-click when the list
 * says so (RFC 8058), else mailto, else a link for the browser. Null when the
 * headers offer none (or only plain http, which monday does not open).
 */
export function unsubscribePlan(headers: Readonly<Record<string, string>>): UnsubscribePlan | null {
  const header = headers["list-unsubscribe"] ?? "";
  if (!header) return null;
  const all = entries(header);
  const https = all.find((e) => /^https:\/\//i.test(e));
  const mailto = all.find((e) => /^mailto:/i.test(e));
  const post = headers["list-unsubscribe-post"] ?? "";
  if (https && /List-Unsubscribe\s*=\s*One-Click/i.test(post)) {
    return { method: "one_click", target: https };
  }
  if (mailto) {
    const raw = mailto.slice("mailto:".length);
    const [address, query = ""] = raw.split("?");
    const params = new URLSearchParams(query);
    const to = decodeURIComponent(address ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(to)) return null;
    return {
      method: "mailto",
      target: to,
      subject: params.get("subject") ?? undefined,
      body: params.get("body") ?? undefined,
    };
  }
  if (https) return { method: "browser", target: https };
  return null;
}

/** The list's name for the card: the List-Id's phrase, else its id, else the sender's name. */
export function listName(headers: Readonly<Record<string, string>>, fallback: string): string {
  const id = headers["list-id"] ?? "";
  const phrase = id.replace(/<[^>]*>/g, "").replace(/"/g, "").trim();
  if (phrase) return phrase;
  const inner = /<([^>]+)>/.exec(id)?.[1]?.trim();
  return inner || fallback;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The RFC 8058 request: a POST of `List-Unsubscribe=One-Click` as a form to
 * the list's https URL, no cookies, no redirects followed. Never a GET.
 */
export async function oneClick(url: string, fetchImpl: Fetch): Promise<{ status: number }> {
  if (!/^https:\/\//i.test(url)) throw new Error("one-click needs an https URL");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
    credentials: "omit",
  });
  return { status: res.status };
}
