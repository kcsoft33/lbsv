/// <reference types="chrome" />
import { ext } from "./browserApi.ts";
import type { BgRequest, BgResponse, BgStatus } from "./messages.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABELS: Record<BgStatus["status"], string> = {
  unpaired: "Not paired", idle: "Starting…", connecting: "Connecting…", online: "Connected",
  offline: "Can't reach the hub. Retrying (changes are kept and sent on reconnect)", unauthorized: "The hub rejected this browser's token (revoked?). Pair again with a new code, or click Reconnect if the hub was just restored", stopped: "Stopped",
};

async function call(m: BgRequest): Promise<BgStatus> {
  const r = await ext.runtime.sendMessage(m) as BgResponse;
  if (!r?.ok) throw new Error(r ? r.error : "The extension background didn't answer.");
  return r.status;
}

function show(s: BgStatus) {
  $("dot").className = "dot " + s.status;
  $("statusText").textContent = LABELS[s.status] + (s.detail && s.status !== "online" ? ` — ${s.detail}` : "");
  const facts: [string, string][] = [["Browser", `${s.family} · extension ${s.version}`]];
  if (s.paired) {
    facts.push(["Hub", s.hubUrl], ["Device", s.deviceName], ["Profile", s.profile || "Default"]);
    if (s.lastSnapshot?.at) facts.push(["Last full sync", `${new Date(s.lastSnapshot.at).toLocaleTimeString()}: ${s.lastSnapshot.tabs} tabs${s.lastSnapshot.denied ? `, ${s.lastSnapshot.denied} on the deny-list` : ""}`]);
  }
  $("facts").innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("pairedActs").classList.toggle("hidden", !s.paired);
  $("settingsForm").classList.toggle("hidden", !s.paired);
  $("pairForm").classList.toggle("hidden", s.paired && s.status !== "unauthorized");
  const prof = $<HTMLInputElement>("profile");
  if (document.activeElement !== prof) prof.value = s.profile;
  $<HTMLInputElement>("includeInternal").checked = s.includeInternal;
  if (!$<HTMLInputElement>("hubUrl").value && s.hubUrl) $<HTMLInputElement>("hubUrl").value = s.hubUrl;
}

async function act(m: BgRequest, btn?: HTMLButtonElement) {
  $("err").textContent = "";
  if (btn) btn.disabled = true;
  try { show(await call(m)); } catch (e) { $("err").textContent = (e as Error).message; } finally { if (btn) btn.disabled = false; }
}

$("pairForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const btn = (e.target as HTMLFormElement).querySelector("button")!;
  void act({ type: "pair", hubUrl: $<HTMLInputElement>("hubUrl").value, code: $<HTMLInputElement>("code").value, profile: $<HTMLInputElement>("profileNew").value }, btn)
    .then(() => { if (!$("err").textContent) $<HTMLInputElement>("code").value = ""; });
});
$("settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void act({ type: "settings", profile: $<HTMLInputElement>("profile").value, includeInternal: $<HTMLInputElement>("includeInternal").checked },
    (e.target as HTMLFormElement).querySelector("button")!);
});
$("reconnect").addEventListener("click", (e) => void act({ type: "reconnect" }, e.target as HTMLButtonElement));
$("unpair").addEventListener("click", (e) => {
  if (confirm("Unpair this browser? Its tabs stay in the hub (shown as stale) until you revoke the device there.")) void act({ type: "unpair" }, e.target as HTMLButtonElement);
});

const poll = () => call({ type: "status" }).then(show, (e) => { $("err").textContent = (e as Error).message; });
void poll();
setInterval(poll, 2000);
