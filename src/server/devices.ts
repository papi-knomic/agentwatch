import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readTextIfExists, writeFileAtomic } from "../core/fs.js";

/** A phone (or other browser) paired for remote access. The secret itself is never stored, only its hash. */
export interface Device {
  id: string;
  name: string;
  secretHash: string;
  createdAt: string;
  lastSeenAt: string;
  allowApprovals: boolean;
}

/** What the dashboard may see about a device. */
export type DeviceInfo = Omit<Device, "secretHash">;

/**
 * The `__Host-` prefix makes browsers accept the cookie only with Secure, Path=/ and no Domain attribute, so a
 * sibling service on the same ts.net name (another port) can't plant or overwrite it. Cookies ignore ports though, so
 * such a service can still *read* it: see the README.
 */
export const DEVICE_COOKIE = "__Host-aw_device";
export const DEVICE_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;
export const MAX_DEVICE_NAME = 40;
const MAX_DEVICES = 50;
/** lastSeenAt is kept current in memory but written to disk at most this often. */
const SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
/** After a failed save (e.g. a revoke that did not reach the disk) the next request retries at most this often. */
const RETRY_WRITE_INTERVAL_MS = 10_000;

export type DeviceWriter = (path: string, contents: string) => Promise<void>;

const DEVICE_ID = /^[A-Za-z0-9_-]{8,32}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters have no place in a label that is rendered in the dashboard.
  const printable = [...value]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("");
  const name = printable.trim().slice(0, MAX_DEVICE_NAME).trim();
  return name === "" ? null : name;
}

function parseDevice(value: unknown): Device | null {
  if (!isRecord(value)) return null;
  const { id, secretHash, createdAt, lastSeenAt, allowApprovals } = value;
  const name = cleanDeviceName(value.name);
  if (typeof id !== "string" || !DEVICE_ID.test(id) || name === null) return null;
  if (typeof secretHash !== "string" || !HASH.test(secretHash)) return null;
  const validDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
  if (!validDate(createdAt) || !validDate(lastSeenAt)) return null;
  return { id, name, secretHash, createdAt, lastSeenAt, allowApprovals: allowApprovals === true };
}

function publicInfo({ secretHash: _secretHash, ...info }: Device): DeviceInfo {
  return info;
}

/** Paired devices, kept in memory and in `devices.json` (hashes only). */
export class DeviceStore {
  private devices = new Map<string, Device>();
  // Starts "just written": the first request after boot must not trigger a write of an unchanged file.
  private lastWrite = Date.now();
  private lastRetry = 0;
  /** True while memory holds changes (e.g. a revoke) that the file does not have yet. */
  private dirty = false;
  private queue: Promise<void> = Promise.resolve();

  /** Without a path the store lives in memory only (tests). `write` is injectable for failure tests. */
  constructor(
    private readonly path?: string,
    private readonly write: DeviceWriter = writeFileAtomic,
  ) {}

  /** Resolves when every queued write has finished (success or not). */
  async idle(): Promise<void> {
    let queue: Promise<void>;
    do {
      queue = this.queue;
      await queue;
    } while (queue !== this.queue);
  }

  /** Whether memory has changes that are not on disk yet. */
  get unsaved(): boolean {
    return this.dirty;
  }

  async load(): Promise<void> {
    if (!this.path) return;
    const text = await readTextIfExists(this.path);
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // A damaged file means no paired devices, never a crash.
    }
    const list = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : [];
    for (const item of list.slice(0, MAX_DEVICES)) {
      const device = parseDevice(item);
      if (device) this.devices.set(device.id, device);
    }
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map(publicInfo);
  }

  get(id: string): DeviceInfo | null {
    const device = this.devices.get(id);
    return device ? publicInfo(device) : null;
  }

  /** Returns the cookie value to hand to the browser: the only time the secret exists outside its hash. */
  async create(name: string): Promise<{ device: DeviceInfo; cookieValue: string } | null> {
    if (this.devices.size >= MAX_DEVICES) return null;
    const id = randomBytes(9).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const device: Device = {
      id,
      name,
      secretHash: sha256Hex(secret),
      createdAt: now,
      lastSeenAt: now,
      allowApprovals: false,
    };
    this.devices.set(id, device);
    await this.save();
    return { device: publicInfo(device), cookieValue: `${id}.${secret}` };
  }

  /** Checks the Cookie header. Updates lastSeenAt, writing to disk only now and then. */
  authenticate(cookieHeader: string | undefined): DeviceInfo | null {
    const value = readCookie(cookieHeader, DEVICE_COOKIE);
    if (value === null) return null;
    const dot = value.indexOf(".");
    if (dot < 0) return null;
    const id = value.slice(0, dot);
    const secret = value.slice(dot + 1);
    if (!DEVICE_ID.test(id) || !SECRET.test(secret)) return null;
    const device = this.devices.get(id);
    const expected = Buffer.from(device?.secretHash ?? "0".repeat(64), "hex");
    const presented = Buffer.from(sha256Hex(secret), "hex");
    if (!timingSafeEqual(expected, presented) || !device) return null;
    const now = Date.now();
    device.lastSeenAt = new Date(now).toISOString();
    if (this.dirty && now - this.lastRetry >= RETRY_WRITE_INTERVAL_MS) {
      // A change (typically a revoke) never reached the disk: try again before it can come back after a restart.
      this.lastRetry = now;
      void this.save().catch(() => {});
    } else if (now - this.lastWrite >= SEEN_WRITE_INTERVAL_MS) {
      this.lastWrite = now;
      void this.save().catch(() => {});
    }
    return publicInfo(device);
  }

  async update(id: string, patch: { allowApprovals?: boolean; name?: string }): Promise<DeviceInfo | null> {
    const device = this.devices.get(id);
    if (!device) return null;
    if (patch.allowApprovals !== undefined) device.allowApprovals = patch.allowApprovals;
    if (patch.name !== undefined) device.name = patch.name;
    await this.save();
    return publicInfo(device);
  }

  /**
   * Revokes in memory first, so the device is dead at once. If the save then fails this throws, but the device stays
   * revoked in memory and the next write (or an authenticated request after a short delay) retries the save.
   */
  async revoke(id: string): Promise<boolean> {
    if (!this.devices.delete(id)) return false;
    await this.save();
    return true;
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    this.dirty = true;
    // Writes are serialised so two quick changes never race on the temp file. Each writes the state as it is when
    // its turn comes, so a later save also carries an earlier failed one.
    const run = async () => {
      const body = { devices: [...this.devices.values()] };
      await this.write(path, `${JSON.stringify(body, null, 2)}\n`);
      // Only clean if nothing newer was queued behind this write.
      if (this.queue === settled) this.dirty = false;
    };
    const next = this.queue.then(run, run);
    const settled: Promise<void> = next.catch(() => {});
    this.queue = settled;
    return next;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function deviceCookie(value: string): string {
  return `${DEVICE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`;
}

export interface PairingOptions {
  codeTtlMs?: number;
  maxOutstanding?: number;
  /** Failed attempts allowed within `windowMs`. */
  maxAttempts?: number;
  windowMs?: number;
}

/**
 * Single-use pairing codes (shown as a QR code on the PC) with a global brute-force limit. Only failed attempts
 * count, so a flood of guesses locks guessing out but a valid code never competes with other successes; failures age
 * out after a minute and are forgotten when the PC dashboard makes a new code (the user is clearly present).
 */
export class PairingCodes {
  private readonly codes = new Map<string, number>(); // sha256(code) -> expiry
  private failures: number[] = [];
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(options: PairingOptions = {}) {
    this.ttlMs = options.codeTtlMs ?? 2 * 60_000;
    this.maxOutstanding = options.maxOutstanding ?? 3;
    this.maxAttempts = options.maxAttempts ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
  }

  create(): { code: string; expiresAt: string } {
    const now = Date.now();
    this.purge(now);
    this.failures = [];
    // The oldest goes when a fourth is asked for.
    while (this.codes.size >= this.maxOutstanding) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = randomBytes(24).toString("base64url"); // 192 bits
    const expires = now + this.ttlMs;
    this.codes.set(sha256Hex(code), expires);
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * Failed guesses are capped globally (not per client: behind a proxy every request looks alike). Returns
   * "limited" while the cap is hit, even for a valid code.
   */
  consume(code: unknown): "ok" | "invalid" | "limited" {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    if (this.failures.length >= this.maxAttempts) return "limited";
    this.purge(now);
    // Looked up by hash of a 192-bit random value: nothing useful to learn from timing.
    if (
      typeof code === "string" &&
      code.length > 0 &&
      code.length <= 128 &&
      this.codes.delete(sha256Hex(code))
    ) {
      return "ok";
    }
    this.failures.push(now);
    return "invalid";
  }

  private purge(now: number): void {
    for (const [hash, expires] of this.codes) if (expires <= now) this.codes.delete(hash);
  }
}
