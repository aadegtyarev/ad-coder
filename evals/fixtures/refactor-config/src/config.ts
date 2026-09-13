export function loadHost(env: Record<string, string | undefined>): string {
  const raw = env.APP_HOST;
  if (raw === undefined || raw.trim() === "") return "127.0.0.1";
  return raw.trim();
}
export function loadWorkerHost(env: Record<string, string | undefined>): string {
  const raw = env.APP_HOST;
  if (raw === undefined || raw.trim() === "") return "127.0.0.1";
  return raw.trim();
}
