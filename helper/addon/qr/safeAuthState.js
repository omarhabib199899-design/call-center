/**
 * [CUSTOM] Crash-safe replacement for Baileys' useMultiFileAuthState.
 *
 * Why: Baileys saves creds.json with a plain fs.writeFile, which first empties
 * the file and then writes it. If the process is killed in between (Passenger
 * restarts, out of memory) or the disk / inode quota is full, creds.json is
 * left EMPTY. On the next start Baileys can't read it, silently starts a new
 * login and shows a QR code: the number is "disconnected while working" and
 * has to be scanned again. That is exactly what happened on 2026-10-25 15:21
 * to ksa-RD, ksa-khobar and DUBAI (0-byte creds.json, keys still there).
 *
 * What this does differently, with the same folder layout and file names, so
 * existing sessions load unchanged:
 *   - every file is written to a temp file first and then renamed over the
 *     old one. A rename is atomic: the file is either the old version or the
 *     new one, never empty or half written.
 *   - creds.json also keeps creds.json.bak (the previous good copy). If
 *     creds.json is missing/empty/corrupt on start, the backup is used.
 *   - write failures are logged loudly (disk full / quota) instead of being
 *     swallowed.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

let baileys = null;
async function lib() {
  if (!baileys) baileys = await import("baileys");
  return baileys;
}

// One queue per file so reads/writes of the same file never overlap.
const queues = new Map();
function locked(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    file,
    next.catch(() => {}).finally(() => {
      if (queues.get(file) === next) queues.delete(file);
    }),
  );
  return next;
}

const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

function log(folder, ...args) {
  console.log(`[WA auth ${path.basename(folder)}]`, ...args);
}

async function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readJson(filePath, reviver) {
  const text = await fsp.readFile(filePath, { encoding: "utf-8" });
  if (!text || !text.trim()) throw new Error("empty file");
  return JSON.parse(text, reviver);
}

/** Remove temp files left behind by a crash mid-write. */
async function sweepTemps(folder) {
  try {
    const names = await fsp.readdir(folder);
    await Promise.all(
      names
        .filter((n) => n.includes(".tmp-"))
        .map((n) => fsp.unlink(path.join(folder, n)).catch(() => {})),
    );
  } catch (e) {}
}

async function useSafeMultiFileAuthState(folder) {
  const { proto, initAuthCreds, BufferJSON } = await lib();

  const info = await fsp.stat(folder).catch(() => null);
  if (info && !info.isDirectory()) {
    throw new Error(`not a directory: ${folder}`);
  }
  if (!info) await fsp.mkdir(folder, { recursive: true });
  await sweepTemps(folder);

  const writeData = (data, file) => {
    const filePath = path.join(folder, fixFileName(file));
    return locked(filePath, async () => {
      try {
        await atomicWrite(filePath, JSON.stringify(data, BufferJSON.replacer));
      } catch (err) {
        log(folder, `could not save ${file}: ${err.code || ""} ${err.message}` +
          (err.code === "ENOSPC" || err.code === "EDQUOT"
            ? "  <-- DISK OR FILE QUOTA FULL"
            : ""));
        throw err;
      }
    });
  };

  const readData = (file) => {
    const filePath = path.join(folder, fixFileName(file));
    return locked(filePath, async () => {
      try {
        return await readJson(filePath, BufferJSON.reviver);
      } catch (e) {
        return null;
      }
    });
  };

  const removeData = (file) => {
    const filePath = path.join(folder, fixFileName(file));
    return locked(filePath, async () => {
      await fsp.unlink(filePath).catch(() => {});
    });
  };

  // creds: main file, else the backup, else a fresh login (QR).
  const credsPath = path.join(folder, "creds.json");
  const bakPath = path.join(folder, "creds.json.bak");
  let creds = await readData("creds.json");
  if (!creds) {
    try {
      creds = await readJson(bakPath, BufferJSON.reviver);
      log(folder, "creds.json was empty or broken — restored from creds.json.bak");
      await atomicWrite(credsPath, JSON.stringify(creds, BufferJSON.replacer)).catch(() => {});
    } catch (e) {
      creds = null;
    }
  }
  if (!creds) creds = initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData(creds, "creds.json");
      // Keep the previous good copy only for a logged-in session, so a
      // half-finished QR login never overwrites a real backup.
      if (creds?.me) {
        await locked(bakPath, () =>
          atomicWrite(bakPath, JSON.stringify(creds, BufferJSON.replacer)),
        ).catch(() => {});
      }
    },
  };
}

module.exports = { useSafeMultiFileAuthState };
