// Live validation of a pasted client registration, called by the wizard on
// every paste (ADR 0008: "live-validated paste boxes"). Cheap and safe: one
// GET on the issuer's discovery document, then one token request with a
// deliberately invalid code. The issuer validates the client before the code,
// so the error it answers with tells a bad client id from a bad secret (Google)
// or a missing public client platform (Entra) without ever completing a grant.

import type { FetchLike } from "../jmap/client.ts";
import { postForm } from "./flow.ts";
import {
  GOOGLE_DISCOVERY_URL,
  GOOGLE_TOKEN_URL,
  MICROSOFT_LOGIN_BASE,
  microsoftDiscoveryUrl,
  normalizeTenant,
} from "./issuers.ts";

export type ValidationField = "clientId" | "clientSecret" | "tenant" | "network";

export type ValidationResult =
  | { ok: true; detail: string }
  | { ok: false; field: ValidationField; reason: string };

export interface ValidateDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
}

const PROBE_CODE = "monday-validation-probe";

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface TokenError {
  status: number;
  error: string;
  description: string;
}

async function tokenError(response: Response): Promise<TokenError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return {
    status: response.status,
    error: typeof body.error === "string" ? body.error : "",
    description: typeof body.error_description === "string" ? body.error_description : "",
  };
}

export async function validateGoogleClient(
  input: { clientId: string; clientSecret?: string | null },
  deps: ValidateDeps = {},
): Promise<ValidationResult> {
  const fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
  const timeout = deps.timeoutMs ?? 8_000;
  const clientId = input.clientId.trim();
  if (!clientId) return { ok: false, field: "clientId", reason: "Paste the client id." };
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    return {
      ok: false,
      field: "clientId",
      reason: "A Google client id ends in .apps.googleusercontent.com.",
    };
  }
  try {
    const discovery = await withTimeout(fetchImpl(GOOGLE_DISCOVERY_URL), timeout);
    if (!discovery.ok) {
      return { ok: false, field: "network", reason: `Google answered ${discovery.status}.` };
    }
  } catch (error) {
    return { ok: false, field: "network", reason: `Cannot reach Google: ${String(error)}` };
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: PROBE_CODE,
    client_id: clientId,
    redirect_uri: "http://127.0.0.1",
    code_verifier: "monday-validation-probe-verifier-monday-validation-probe",
  });
  if (input.clientSecret?.trim()) params.set("client_secret", input.clientSecret.trim());
  let error: TokenError;
  try {
    error = await tokenError(
      await withTimeout(postForm(fetchImpl, GOOGLE_TOKEN_URL, params), timeout),
    );
  } catch (cause) {
    return { ok: false, field: "network", reason: `Cannot reach Google: ${String(cause)}` };
  }
  if (error.error === "invalid_grant") {
    return { ok: true, detail: "Google recognizes this client id and secret." };
  }
  if (error.error === "invalid_client") {
    if (/not found/i.test(error.description)) {
      return {
        ok: false,
        field: "clientId",
        reason: "Google has no OAuth client with this id. Check the project and the client.",
      };
    }
    return {
      ok: false,
      field: "clientSecret",
      reason: "Google rejected the client secret. Paste the secret shown for this client.",
    };
  }
  if (error.error === "invalid_request" && /client_secret/i.test(error.description)) {
    return { ok: false, field: "clientSecret", reason: "This client needs its client secret." };
  }
  return {
    ok: false,
    field: "network",
    reason:
      `Unexpected answer from Google: ${error.error || error.status} ${error.description}`.trim(),
  };
}

export async function validateMicrosoftClient(
  input: { clientId: string; tenant?: string | null },
  deps: ValidateDeps = {},
): Promise<ValidationResult> {
  const fetchImpl = deps.fetch ?? ((u, i) => fetch(u, i));
  const timeout = deps.timeoutMs ?? 8_000;
  const clientId = input.clientId.trim();
  const tenant = normalizeTenant(input.tenant);
  if (!clientId) return { ok: false, field: "clientId", reason: "Paste the application id." };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    return {
      ok: false,
      field: "clientId",
      reason: "An application (client) id is a GUID like 12345678-1234-1234-1234-123456789abc.",
    };
  }
  try {
    const discovery = await withTimeout(fetchImpl(microsoftDiscoveryUrl(tenant)), timeout);
    if (!discovery.ok) {
      const err = await tokenError(discovery);
      return {
        ok: false,
        field: "tenant",
        reason:
          err.error === "invalid_tenant" || discovery.status === 400
            ? `Microsoft has no tenant "${tenant}". Paste the directory (tenant) id, or use consumers for a personal account.`
            : `Microsoft answered ${discovery.status} for tenant ${tenant}.`,
      };
    }
  } catch (error) {
    return { ok: false, field: "network", reason: `Cannot reach Microsoft: ${String(error)}` };
  }
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: PROBE_CODE,
    client_id: clientId,
    redirect_uri: "http://localhost",
    code_verifier: "monday-validation-probe-verifier-monday-validation-probe",
    scope: "User.Read offline_access",
  });
  let error: TokenError;
  try {
    error = await tokenError(
      await withTimeout(
        postForm(
          fetchImpl,
          `${MICROSOFT_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
          params,
        ),
        timeout,
      ),
    );
  } catch (cause) {
    return { ok: false, field: "network", reason: `Cannot reach Microsoft: ${String(cause)}` };
  }
  const d = error.description;
  if (/AADSTS700016/.test(d) || error.error === "unauthorized_client") {
    return {
      ok: false,
      field: "clientId",
      reason:
        tenant === "consumers" || tenant === "common"
          ? "Microsoft has no app with this id for personal accounts. Check the id and the account type you chose."
          : `Microsoft has no app with this id in tenant ${tenant}. Check the id, or the tenant it was registered in.`,
    };
  }
  if (/AADSTS7000218/.test(d)) {
    return {
      ok: false,
      field: "clientId",
      reason:
        "This app is not a public client yet. Add the Mobile and desktop platform with the http://localhost redirect.",
    };
  }
  if (/AADSTS50059|AADSTS90002/.test(d)) {
    return { ok: false, field: "tenant", reason: `Microsoft has no tenant "${tenant}".` };
  }
  if (error.error === "invalid_grant" || error.error === "invalid_request") {
    return { ok: true, detail: `Microsoft recognizes this app in ${tenant}.` };
  }
  return {
    ok: false,
    field: "network",
    reason: `Unexpected answer from Microsoft: ${error.error || error.status} ${d}`.trim(),
  };
}
