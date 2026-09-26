import type { APIRequestContext, Page } from '@playwright/test';

import { E2E_ADMIN_BASE_URL, E2E_API_BASE_URL } from '../env.js';

/** Cookie-mode admin mutations require Origin to match the Admin allowlist. */
export function adminOriginHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Origin: E2E_ADMIN_BASE_URL,
    Referer: `${E2E_ADMIN_BASE_URL}/`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

export function apiRequest(page: Page): APIRequestContext {
  return page.context().request;
}

export async function adminGet(
  page: Page,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await apiRequest(page).get(`${E2E_API_BASE_URL}${path}`, {
    headers: adminOriginHeaders(),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status(), body };
}

export async function adminPost(
  page: Page,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await apiRequest(page).post(`${E2E_API_BASE_URL}${path}`, {
    headers: adminOriginHeaders(headers),
    data,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status(), body };
}

export function errorCode(body: unknown): string | null {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const code = (body as { error?: unknown }).error;
    if (typeof code === 'string') return code;
  }
  return null;
}
