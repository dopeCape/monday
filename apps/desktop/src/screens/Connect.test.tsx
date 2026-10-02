import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { encodePairingPayload } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { FetchLike } from "../platform/cloud.ts";
import type { RemoteTarget } from "../platform/remote.ts";
import { Connect, type ConnectProps, RemoteStatus } from "./Connect.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(node));
}

const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const settle = () => act(async () => Bun.sleep(10));

async function clickText(label: string) {
  const el = [...document.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`no button ${label}`);
  await act(async () => el.click());
  await settle();
}

async function type(selector: string, value: string) {
  const input = q<HTMLInputElement>(selector);
  if (!input) throw new Error(`no ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function server(status = 201) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "null")) });
    return status === 201
      ? Response.json({ deviceId: "d", token: "t", name: "tejas-laptop" }, { status })
      : Response.json({ error: "x" }, { status });
  };
  return { calls, fetch };
}

describe("Connect to your monday", () => {
  test("scans the QR code and pairs", async () => {
    const s = server();
    const connected: RemoteTarget[] = [];
    const props: ConnectProps = {
      deviceName: "Pixel 9",
      onConnected: (t) => connected.push(t),
      fetch: s.fetch,
      scanQr: async () =>
        encodePairingPayload({
          name: "tejas-laptop",
          urls: ["http://192.168.1.20:47820"],
          secret: "sec",
          code: "AB12CD34",
          expiresAt: "2026-10-02T12:10:00Z",
          fingerprint: null,
        }),
    };
    await render(<Connect {...props} />);
    expect(q("h1")?.textContent).toBe("Connect to your monday");
    // The scanner first; typing waits behind its own button.
    expect(q("#connect-url")).toBeNull();
    await clickText("Scan QR code");
    expect(s.calls).toEqual([
      {
        url: "http://192.168.1.20:47820/pair/redeem",
        body: { secret: "sec", name: "Pixel 9", kind: "phone" },
      },
    ]);
    expect(connected).toEqual([
      {
        baseUrl: "http://192.168.1.20:47820",
        token: "t",
        deviceId: "d",
        name: "tejas-laptop",
        fingerprint: null,
      },
    ]);
  });

  test("without a scanner, the address and the short code are typed; refusals are said", async () => {
    const s = server(410);
    await render(<Connect deviceName="Emulator" onConnected={() => {}} fetch={s.fetch} />);
    expect(q("button")?.textContent).not.toBe("Scan QR code");
    await type("#connect-url", "http://mail.example.com");
    await type("#connect-code", "ab12-cd34");
    await clickText("Connect");
    expect(q('[role="alert"]')?.textContent).toContain("Plain http:// works only");
    expect(s.calls).toEqual([]);

    await type("#connect-url", "http://10.0.2.2:41234");
    await clickText("Connect");
    expect(s.calls[0]?.url).toBe("http://10.0.2.2:41234/pair/redeem");
    expect(q('[role="alert"]')?.textContent).toContain("That code did not work");
  });

  test("the status line names the Server, or says it is locked", async () => {
    await render(<RemoteStatus state="connected" name="tejas-laptop" />);
    expect(q("[data-remote-state]")?.textContent).toBe("Connected to tejas-laptop");
    await act(async () => root?.render(<RemoteStatus state="locked" name="tejas-laptop" />));
    expect(q("[data-remote-state]")?.textContent).toBe(
      "Your monday is locked. Open it on your computer.",
    );
  });
});
