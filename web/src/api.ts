export type Account = { name: string; csrf: string; iceServers: RTCIceServer[] | null; development: boolean };
export type Room = { id: string; role: 'host' | 'guest'; status: 'waiting' | 'admitted'; host: string; guest?: string; pending?: string; expiresAt: string };
export class APIError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, csrf?: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: csrf ? 'POST' : 'GET', credentials: 'same-origin', headers: csrf ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new APIError(data.error || 'Something went wrong. Please try again.', response.status);
  return data as T;
}
