import type { BrowserFamily } from "../../shared/src/live.ts";
import type { CollectorStatus } from "../../shared/src/collectorClient.ts";

/** Options page → background. */
export type BgRequest =
  | { type: "status" }
  | { type: "pair"; hubUrl: string; code: string; profile: string }
  | { type: "unpair" }
  | { type: "settings"; profile: string; includeInternal: boolean }
  | { type: "reconnect" };

export interface BgStatus {
  paired: boolean;
  hubUrl: string;
  deviceName: string;
  profile: string;
  includeInternal: boolean;
  family: BrowserFamily;
  version: string;
  status: CollectorStatus | "unpaired";
  detail: string;
  lastSnapshot: { tabs: number; denied: number; at: number } | null;
}

export type BgResponse = { ok: true; status: BgStatus } | { ok: false; error: string };
