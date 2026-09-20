export const API_BASE = String(import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");

export function apiUrl(path) {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
