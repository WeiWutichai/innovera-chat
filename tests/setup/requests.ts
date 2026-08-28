/** Builders for the Request objects the route handlers receive. */

type HeaderOverrides = Record<string, string | null>;

/**
 * Builds a POST /api/chat request. Header values of `null` REMOVE the default header —
 * needed to exercise the Origin fallback, which only runs when Sec-Fetch-Site is absent.
 */
export function chatRequest(
  body: unknown,
  init: { headers?: HeaderOverrides; signal?: AbortSignal } = {}
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };

  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }

  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: init.signal,
  });
}

export function conversationRequest(id: string) {
  return new Request(`http://localhost:3000/api/conversations/${id}`);
}

export function routeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}
