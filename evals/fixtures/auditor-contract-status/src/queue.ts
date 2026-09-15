import * as fs from "node:fs";

const QUEUE_FILE = "/var/lib/queue/pending.jsonl";

export interface Job {
  id: string;
  payload: string;
}

/** Conforms: the rejection wording is exactly what the error contract fixes. */
export function parseJob(raw: unknown): Job {
  const job = raw as Partial<Job>;
  if (typeof job?.id !== "string" || !job.id) throw new Error("invalid id");
  if (typeof job.payload !== "string") throw new Error("invalid payload");
  return { id: job.id, payload: job.payload };
}

export function enqueue(job: Job): void {
  const handle = fs.openSync(QUEUE_FILE, "a");
  try {
    fs.writeSync(handle, `${JSON.stringify(job)}\n`);
  } finally {
    fs.closeSync(handle);
  }
}

export function readJob(id: string): Job {
  try {
    const line = fs
      .readFileSync(QUEUE_FILE, "utf8")
      .split("\n")
      .find((entry) => entry.includes(`"id":"${id}"`));
    if (line === undefined) throw new Error("invalid id");
    return JSON.parse(line) as Job;
  } catch {
    throw new Error("queue read failed");
  }
}
