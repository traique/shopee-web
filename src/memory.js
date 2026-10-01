import fs from "node:fs/promises";

async function readNumber(path) {
  try {
    const value = (await fs.readFile(path, "utf8")).trim();
    if (!value || value === "max") {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function memorySnapshot() {
  const usage = await readNumber("/sys/fs/cgroup/memory.current")
    ?? await readNumber("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const limit = await readNumber("/sys/fs/cgroup/memory.max")
    ?? await readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  return {
    usageMb: usage == null ? null : Math.round(usage / 1048576),
    limitMb: limit == null ? null : Math.round(limit / 1048576),
  };
}
