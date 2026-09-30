import { SERVICE_URLS, type Service } from "../config";
import { getToken } from "../auth/token";

/** Error codes the backends attach so a screen can show the right thing (not just a message). */
export const KEYS_REQUIRED = "own_dhan_keys_required";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** The user has no Dhan keys saved and the platform requires their own for live data. */
  get keysRequired(): boolean {
    return this.code === KEYS_REQUIRED;
  }
}

let onUnauthorized: (() => void) | null = null;

/** The auth layer registers what to do when a signed-in session is rejected (401). */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** FastAPI errors are {detail: "text"} or, for a 422, {detail: [{loc, msg}, ...]}. */
export function describeDetail(body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const item = d as { loc?: unknown[]; msg?: string };
        const where = (item.loc ?? []).filter((p) => p !== "body").join(".");
        return where ? `${where}: ${item.msg ?? "invalid"}` : (item.msg ?? "invalid");
      })
      .join("; ");
  }
  return "";
}

export type RequestOptions = Omit<RequestInit, "body"> & {
  json?: unknown;
  /** Set false for the public endpoints (login, signup). Default: send the token if there is one. */
  auth?: boolean;
};

export async function api<T>(service: Service, path: string, options: RequestOptions = {}): Promise<T> {
  const { json, auth = true, headers, ...rest } = options;
  const token = auth ? getToken() : null;
  const finalHeaders: Record<string, string> = { Accept: "application/json", ...(headers as Record<string, string> | undefined) };
  if (json !== undefined) finalHeaders["Content-Type"] = "application/json";
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${SERVICE_URLS[service]}${path}`, { ...rest, headers: finalHeaders, body: json !== undefined ? JSON.stringify(json) : undefined });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.", "network");
  }

  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* not JSON: fall back to the status text */
  }
  const message = describeDetail(body) || response.statusText || `Request failed (${response.status})`;
  let code = response.headers.get("x-error-code") ?? undefined;
  if (!code && message.startsWith(`${KEYS_REQUIRED}:`)) code = KEYS_REQUIRED;

  if (response.status === 401 && token && auth && onUnauthorized) onUnauthorized();
  throw new ApiError(response.status, message.replace(new RegExp(`^${KEYS_REQUIRED}:\\s*`), ""), code);
}
