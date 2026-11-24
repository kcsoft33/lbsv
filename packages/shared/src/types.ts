/**
 * Nested shapes the API returns to the UI. These keep the prototype's field names
 * (leftOff, where, at, updatedAt…) so the ported UI code stays close to the original.
 * Storage is normalised into tables; see packages/hub/migrations.
 */
import type { Rule } from "./rules.ts";

export type Status = "active" | "parked" | "done";
export const STATUSES: Status[] = ["active", "parked", "done"];
export const SESSION_KINDS = ["SSH", "tmux", "RDP", "VM console", "Local term", "Web UI", "Other"] as const;

export interface Link {
  id: string;
  label: string;
  url: string;
  where: string;
  at: number;
  position: number;
}

export interface Session {
  id: string;
  kind: string;
  label: string;
  host: string;
  network: string;
  cmd: string;
  at: number;
  position: number;
}

/** A URL attached to an idea (M2b). */
export interface IdeaLink {
  id: string;
  url: string;
  title: string;
  where: string;
  at: number;
  position: number;
}

export interface Idea {
  id: string;
  text: string;
  at: number;
  /** Always present in hub responses; optional on input (and in pre-M2b exports). */
  links?: IdeaLink[];
}

export interface Project {
  id: string;
  name: string;
  status: Status;
  leftOff: string;
  tags: string;
  createdAt: number;
  updatedAt: number;
  links: Link[];
  sessions: Session[];
  ideas: Idea[];
  /** Always present in hub responses (M3); optional on input and in older exports. */
  rules?: Rule[];
}

export interface State {
  projects: Project[];
  inbox: Idea[];
}

export interface ExportFile extends State {
  format: "lbsv" | "switchboard"; // "switchboard": exported before the rename
  version: 1;
  exportedAt: number;
}

/** Hub -> UI realtime message. */
export interface ChangedMsg {
  t: "changed";
  entity: "project" | "inbox" | "all" | "live" | "devices";
  ids: string[];
}
