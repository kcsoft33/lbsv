import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

declare const __LBSV_VERSION__: string | undefined;
/** Stamped in by the bundle build; from a source checkout, the repo's package.json. */
export const AGENT_VERSION: string = typeof __LBSV_VERSION__ !== "undefined" ? __LBSV_VERSION__ : (() => {
  try { return (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "0.0.0-dev"; }
})();

export interface AgentConfig {
  /** Hub base URL, e.g. https://lbsv.example.net */
  hub: string;
  token: string;
  /** Device name the hub gave us at pairing. */
  device?: string;
}

/** Same layout on every OS so the shell hooks and the agent agree without configuration. */
export function configDir(env = process.env): string {
  return env.LBSV_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "lbsv");
}
export function stateDir(env = process.env): string {
  return env.LBSV_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "lbsv", "shells");
}
export const configFile = (env = process.env) => join(configDir(env), "agent.json");

export function loadConfig(env = process.env): AgentConfig | null {
  try {
    const c = JSON.parse(readFileSync(configFile(env), "utf8")) as AgentConfig;
    if (env.LBSV_HUB) c.hub = env.LBSV_HUB;
    return c.hub && c.token ? c : null;
  } catch { return null; }
}

/** Written 0600 (owner only) via a temp file + rename. Windows ignores the mode; the file lives in the user profile. */
export function saveConfig(c: AgentConfig, env = process.env): string {
  const f = configFile(env);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, f);
  return f;
}
