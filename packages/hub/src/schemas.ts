import { z } from "zod";
import { ULID_RE } from "../../shared/src/ulid.ts";

const id = z.string().regex(ULID_RE, "expected a ULID");
const text = (max: number) => z.string().max(max);
const ts = z.number().int().nonnegative();
const status = z.enum(["active", "parked", "done"]);

export const ProjectCreate = z.object({ id: id.optional(), name: text(500).min(1), status: status.optional() });
export const ProjectPatch = z
  .object({ name: text(500).optional(), status: status.optional(), leftOff: text(100_000).optional(), tags: text(2000).optional() })
  .strict();

export const LinkIn = z.object({
  id: id.optional(),
  label: text(2000).optional(),
  url: text(8192).min(1),
  where: text(500).optional(),
  at: ts.optional(),
  position: z.number().finite().optional(),
});
export const LinksAdd = z.object({ links: z.array(LinkIn).max(5000) });

export const SessionIn = z.object({
  id: id.optional(),
  kind: text(50).optional(),
  label: text(500).optional(),
  host: text(500).optional(),
  network: text(500).optional(),
  cmd: text(4000).optional(),
  at: ts.optional(),
  position: z.number().finite().optional(),
});

const IdeaLinkIn = z.object({ id: id.optional(), url: text(8192).min(1), title: text(2000).optional(), where: text(500).optional(), at: ts.optional(), position: z.number().finite().optional() });
export const IdeaIn = z.object({
  id: id.optional(), text: text(100_000).min(1), projectId: id.nullable().optional(), at: ts.optional(),
  links: z.array(IdeaLinkIn).max(2000).optional(), // undo of a deleted idea brings its links back
});
export const IdeaLinksAdd = z.object({ links: z.array(IdeaLinkIn).min(1).max(2000) });
export const IdeaMove = z.object({ projectId: id.nullable() });

const LinkFull = z.object({ id, label: text(2000), url: text(8192), where: text(500), at: ts, position: z.number().finite() });
const SessionFull = z.object({
  id, kind: text(50), label: text(500), host: text(500), network: text(500), cmd: text(4000), at: ts, position: z.number().finite(),
});
const IdeaLinkFull = z.object({ id, url: text(8192), title: text(2000), where: text(500), at: ts, position: z.number().finite() });
const ruleKind = z.enum(["url_prefix", "domain", "host", "cwd_prefix", "title_regex"]);
export const RuleIn = z.object({ id: id.optional(), kind: ruleKind, pattern: text(2000).min(1), at: ts.optional() });
const RuleFull = z.object({ id, projectId: z.string().max(40).default(""), // ignored on restore: the parent project wins
  kind: ruleKind, pattern: text(2000), at: ts });
const IdeaFull = z.object({ id, text: text(100_000), at: ts, links: z.array(IdeaLinkFull).max(2000).optional() });
export const ProjectFull = z.object({
  id, name: text(500), status, leftOff: text(100_000), tags: text(2000), createdAt: ts, updatedAt: ts,
  links: z.array(LinkFull), sessions: z.array(SessionFull), ideas: z.array(IdeaFull),
  rules: z.array(RuleFull).max(2000).optional(), // M3; absent in older exports
});

export const ImportBody = z.object({
  mode: z.enum(["merge", "replace"]).default("merge"),
  data: z.object({
    format: z.enum(["lbsv", "switchboard"]), // "switchboard" = exports from before the rename
    version: z.literal(1),
    projects: z.array(ProjectFull),
    inbox: z.array(IdeaFull),
  }),
});

export const Login = z.object({ passphrase: z.string().min(1).max(1000) });
export const Setup = z.object({ code: z.string().min(1).max(100), passphrase: z.string().min(8, "Passphrase must be at least 8 characters.").max(1000) });

/* ---------- devices / live (M1) ---------- */
const domains = z.array(z.string().max(253)).max(1000);
export const DeviceCreate = z.object({ name: text(100).trim().min(1) });
// user@host, an ssh_config alias, or host:port style targets; no spaces or shell metacharacters.
const sshDest = z.string().max(255).trim().regex(/^[A-Za-z0-9_.@:%+\[\]-]*$/, "use user@host or an ssh config alias");
export const DevicePatch = z.object({
  name: text(100).trim().min(1).optional(), deny: domains.optional(), sshTarget: sshDest.optional(), sshJump: sshDest.optional(),
}).strict();
export const DenyList = z.object({ domains });

/* ---------- actions (M2) ---------- */
const tabRefs = z.array(z.object({ id: z.string().min(1).max(200), url: text(8192).optional() })).min(1).max(2000);
export const TabFocus = z.object({ tabId: z.string().min(1).max(200) });
export const TabsClose = z.object({ tabs: tabRefs });
export const TabsOpen = z.object({ browserId: z.string().min(1).max(64), urls: z.array(text(8192)).min(1).max(100), windowId: z.string().max(64).optional() });
export const TabsPark = z.object({
  projectId: id.optional(), newProject: text(500).trim().min(1).optional(), tabs: tabRefs, close: z.boolean().default(true),
}).refine((b) => !!b.projectId !== !!b.newProject, { message: "give exactly one of projectId or newProject" });

/* ---------- M2b: attach tabs to ideas, send tabs elsewhere ---------- */
export const LiveAttach = z.object({
  ideaId: id.optional(),
  newIdea: z.object({ text: text(100_000).trim().min(1), projectId: id.nullable().default(null) }).optional(),
  tabs: tabRefs, close: z.boolean().default(false),
}).refine((b) => !!b.ideaId !== !!b.newIdea, { message: "give exactly one of ideaId or newIdea" });
export const LiveSend = z.object({ tabs: tabRefs, toBrowserId: z.string().min(1).max(64), close: z.boolean().default(true) });

export const McpClientCreate = z.object({ name: text(200).min(1) });
