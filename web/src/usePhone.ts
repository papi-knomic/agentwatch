import { useCallback, useEffect, useState } from "react";
import {
  createPairCode,
  detectRemoteHost,
  getRemoteSettings,
  getServeStatus,
  listDevices,
  type PairedDevice,
  type RemoteSettings,
  type ServeOutcome,
  saveRemoteSettings,
  setServe,
} from "./remote";
import { getPhone, type PhoneSettings, type PhoneUpdate, savePhone } from "./setup";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PairState {
  code: string;
  expiresAt: number;
  baseline: number;
  /** Which card asked for it, so the QR code shows up where the click was. */
  from: "wizard" | "card";
}

/**
 * The Phone tab's single source of truth. The wizard and the cards used to each fetch their own copy once, so
 * turning phone access on in the wizard left the advanced card showing "Off". Now there is one copy, refetched
 * after every change and when the tab becomes visible again.
 */
export function usePhone() {
  const [remote, setRemote] = useState<RemoteSettings | null>(null);
  const [serve, setServeState] = useState<ServeOutcome | null>(null);
  const [phone, setPhone] = useState<PhoneSettings | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pair, setPair] = useState<PairState | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [r, s, p, d] = await Promise.allSettled([
      getRemoteSettings(),
      getServeStatus(),
      getPhone(),
      listDevices(),
    ]);
    if (r.status === "fulfilled") setRemote(r.value);
    setServeState(
      s.status === "fulfilled"
        ? s.value
        : { state: "error", message: messageOf((s as PromiseRejectedResult).reason) },
    );
    if (p.status === "fulfilled") setPhone(p.value);
    if (d.status === "fulfilled") setDevices(d.value);
  }, []);

  const reloadDevices = useCallback(() => {
    listDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reload();
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const on = remote?.enabled === true;
  useEffect(() => {
    if (!on) return;
    reloadDevices();
    // While a code is on screen, notice quickly that the phone used it.
    const id = window.setInterval(reloadDevices, pair ? 2000 : 15_000);
    return () => window.clearInterval(id);
  }, [on, pair, reloadDevices]);

  useEffect(() => {
    if (!pair) return;
    const id = window.setTimeout(() => setPair(null), Math.max(pair.expiresAt - Date.now(), 0));
    return () => window.clearTimeout(id);
  }, [pair]);

  useEffect(() => {
    if (pair && devices.length > pair.baseline) {
      const newest = [...devices].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      setJustPaired(newest?.name ?? "Phone");
      setPair(null);
    }
  }, [pair, devices]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Runs Tailscale Serve for the user (on) or removes our mapping (off), then refetches everything. */
  const setAccess = (next: boolean) =>
    run(async () => {
      const outcome = await setServe(next ? "on" : "off");
      if (!next) {
        setPair(null);
        setJustPaired(null);
      }
      if (outcome.message) setMessage(outcome.message);
      await reload();
      // reload() asks Tailscale again; keep the outcome that carries the consent link or the error text.
      if (next && outcome.state !== "on") setServeState(outcome);
    });

  const startPairing = (from: PairState["from"], alsoPush: boolean) =>
    run(async () => {
      if (alsoPush && phone && !phone.enabled) {
        // A fresh random topic on the public ntfy.sh server; generic text only (includeDetails stays off).
        setPhone(await savePhone({ enabled: true }));
      }
      const { code, expiresAt } = await createPairCode();
      setJustPaired(null);
      setPair({ code, expiresAt: Date.parse(expiresAt), baseline: devices.length, from });
    });

  const saveHost = (hosts: string[]) =>
    run(async () => {
      setRemote(await saveRemoteSettings(true, hosts));
      await reload();
    });

  const detectHost = async (): Promise<string | null> => {
    const { host } = await detectRemoteHost();
    return host;
  };

  const updatePhone = async (update: PhoneUpdate) => {
    const next = await savePhone(update);
    setPhone(next);
    return next;
  };

  return {
    remote,
    serve,
    phone,
    devices,
    pair,
    justPaired,
    busy,
    message,
    setMessage,
    reload,
    reloadDevices,
    setAccess,
    startPairing,
    closePair: () => setPair(null),
    saveHost,
    detectHost,
    updatePhone,
  };
}

export type PhoneModel = ReturnType<typeof usePhone>;
