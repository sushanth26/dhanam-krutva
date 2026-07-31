export async function getJson(path) {
  const response = await fetch(path);
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.detail || `Request failed: ${response.status}`);
  }
  return body;
}

export async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.detail || `Request failed: ${response.status}`);
  }
  return body;
}

export async function deleteJson(path) {
  const response = await fetch(path, { method: "DELETE" });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(body.detail || `Request failed: ${response.status}`);
  }
  return body;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    if (response.ok) return {};
    return {
      detail: `Request failed: ${response.status} ${response.statusText || "empty response"}`.trim(),
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) {
      throw new Error("Server returned invalid JSON.");
    }
    return {
      detail: `Request failed: ${response.status}; server returned invalid JSON.`,
    };
  }
}
