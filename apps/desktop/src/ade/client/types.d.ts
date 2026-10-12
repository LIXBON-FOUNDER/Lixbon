// Tipos del contrato AdeClient (documentación; el repo no compila TypeScript).
// Son formas de INTERFAZ en camelCase con los ids del vocabulario canónico (contracts/status-vocabulary.json).
// No son la API definitiva del Core: la traducción desde snake_case y desde el modelo vigente (Task = Attempt)
// vive en CoreAdeClient. Qué slice hace real cada campo: client/fieldSources.js y docs/ade/ARQUITECTURA.md §7.3.

/** Marca de tiempo en milisegundos desde epoch. */
export type Ms = number;

export type VisualGroup = 'active' | 'waiting' | 'needs_person' | 'ok' | 'error' | 'halted';

/** Estado de Attempt (RESERVADO): los 8 de la Task vigente + pending_approval. */
export type AttemptState =
  | 'pending_approval' | 'starting' | 'running' | 'waiting' | 'awaiting_terminal_approval'
  | 'done' | 'failed' | 'stopped' | 'exited';

/** Estado derivado de la Task (RESERVADO). */
export type TaskDerivedState = 'open' | 'in_progress' | 'in_review' | 'integrated' | 'discarded';

export type AttentionKind =
  | 'approve_in_terminal' | 'integrate' | 'review' | 'failed'   // vigentes
  | 'pending_spawn' | 'unanswered_question';                    // reservados (G decide)

export type EntityKind =
  | 'project' | 'task' | 'attempt' | 'thread' | 'worktree' | 'artifact'
  | 'review' | 'integration' | 'agent' | 'decision' | 'policy' | 'attention';

export interface EntityRef { kind: EntityKind; id: string }

export interface ProjectLocation { machine: string; path: string; primary: boolean; state: 'ok' | 'missing'; lastSeen: Ms }
export interface Project {
  id: string; name: string; state: 'active' | 'archived'; defaultBranch: string; locations: ProjectLocation[];
}

export interface Task {
  id: string; projectId: string; title: string; objective: string;
  derivedState: TaskDerivedState; attemptIds: string[]; threadIds: string[];
  createdAt: Ms; updatedAt: Ms;
}

export interface AgentRef { provider: string; model: string | null; effort: string | null; role: string | null }
export interface EffectivePolicy {
  status: 'ok' | 'blocked' | 'unverified'; command: string[]; warnings: string[];
  /** Sandbox/permisos elevados. Sin confirmar en el código vigente: lo definirá F. */
  elevated: boolean;
}
export interface PendingQuestion { id: string; text: string; askedAt: Ms }

export interface Attempt {
  id: string; taskId: string; projectId: string; ordinal: number; state: AttemptState; agent: AgentRef;
  startedAt: Ms; updatedAt: Ms; endedAt: Ms | null;
  phase: string | null; note: string | null; summary: string | null;
  failureReason: 'terminal_approval_timeout' | 'agent_idle_timeout' | null;
  approvalDeadline: Ms | null;
  policy: EffectivePolicy;
  pendingQuestion: PendingQuestion | null;
  worktreeId: string | null; contextPackageId: string | null;
}

export type MessageKind = 'phase' | 'done' | 'question' | 'reply' | 'note' | 'exited';
export interface ThreadMessage {
  id: string; kind: MessageKind; at: Ms; attemptId: string | null; replyTo: string | null;
  author: { kind: 'human' | 'agent' | 'system'; label: string };
  /** Solo en el Desktop local; con `metadata-only` otros clientes no reciben el texto. */
  text: string | null;
}
export interface Thread {
  id: string; taskId: string; title: string; syncPolicy: 'local-only' | 'metadata-only' | 'summary' | 'full-transcript';
  attemptIds: string[]; messageCount: number; lastMessageAt: Ms | null; messages?: ThreadMessage[];
}

export interface Worktree {
  id: string; attemptId: string; path: string; branch: string | null; baseCommit: string | null; headCommit: string | null;
  dirty: boolean; exists: boolean;
}
/** `kind` no tiene vocabulario canónico todavía (H no define Artifact). */
export interface Artifact { id: string; attemptId: string; kind: string; title: string; createdAt: Ms }

export interface Review {
  attemptId: string; state: 'none' | 'stale' | 'accepted' | 'rejected';
  decision: 'accepted' | 'rejected' | null; headCommit: string | null; currentHeadCommit: string | null; at: Ms | null;
  by: { kind: 'human' | 'agent' | 'system'; client: string | null } | null;
  diffStat: { files: number; additions: number; deletions: number } | null;
}
export interface Integration {
  attemptId: string; outcome: 'merged' | 'conflict' | 'error' | 'target_moved' | null;
  into: string | null; resultCommit: string | null; at: Ms | null;
  /** Regla del Core (hoy canIntegrate.js en el frontend). La interfaz no la recalcula. */
  eligibility: { allowed: boolean; reason: string | null };
}

export interface AttentionItem {
  id: string; kind: AttentionKind; entity: EntityRef;
  projectId: string; taskId: string | null; attemptId: string | null;
  /** Motivo de máquina: `failure_reason` en `failed`, `review_state` (`none`|`stale`) en `review`; null en el resto. */
  reason: string | null;
  /** Título de la Task (texto de la persona, no de interfaz). Las etiquetas y pistas las pone la interfaz. */
  subject: string;
  createdAt: Ms; dueAt: Ms | null;
  /** No definida todavía (G). La interfaz no la usa para ordenar. */
  severity?: string | null;
  /** Estado por persona y dispositivo (G + F). */
  person: { seen: boolean; snoozedUntil: Ms | null };
}

export interface ActivityEntry {
  seq: number; id: string; ts: Ms; type: string; entity: EntityRef;
  projectId: string; taskId: string | null; attemptId: string | null;
  actor: { kind: 'human' | 'agent' | 'system'; id: string; label: string; client: 'desktop' | 'cli' | 'mobile' | null };
  data: Record<string, unknown>;
}

export interface AgentProvider {
  id: string; label: string; available: boolean; policyStatus: 'ok' | 'blocked' | 'unverified';
  models: { id: string; label: string }[]; efforts: string[]; roles: string[];
}

export interface ClientConnection {
  clientKind: 'desktop' | 'cli' | 'mobile'; label: string; scopes: string[];
  source: 'mock' | 'core'; coreMode: 'in_process' | 'daemon';
}

export type Availability = 'available' | 'simulated' | 'unavailable';
export interface Capability {
  intent: string; availability: Availability;
  /** Slice que la hace real (o la habilita). null = vigente sin dependencia nueva. */
  slice: string | null; reason: string; requiresConfirmation: boolean;
}

export interface Location { projectId: string | null; taskId: string | null; attemptId: string | null; worktreeId: string | null }
export interface LocationRef { path?: string; worktreePath?: string; branch?: string }

export interface Intent { type: string; [arg: string]: unknown }
export interface IntentResult { ok: true; simulated: boolean; intent: string; effects: EntityRef[]; message: string }

export interface ChangeNotice { type: 'changed'; entities: EntityRef[]; seq: number | null }

export interface AdeClient {
  getConnection(): Promise<ClientConnection>;
  getCapabilities(): Promise<Record<string, Capability>>;
  listProjects(opts?: { includeArchived?: boolean }): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  listTasks(opts?: { projectId?: string }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  listAttempts(opts?: { taskId?: string; projectId?: string }): Promise<Attempt[]>;
  getAttempt(id: string): Promise<Attempt>;
  listThreads(opts: { taskId: string }): Promise<Thread[]>;
  getThread(id: string): Promise<Thread & { messages: ThreadMessage[] }>;
  listWorktrees(opts: { attemptId: string }): Promise<Worktree[]>;
  listArtifacts(opts: { attemptId: string }): Promise<Artifact[]>;
  getReview(attemptId: string): Promise<Review>;
  getIntegration(attemptId: string): Promise<Integration>;
  listAttention(opts?: { projectId?: string; attemptId?: string }): Promise<AttentionItem[]>;
  listActivity(opts?: { projectId?: string; taskId?: string; attemptId?: string; limit?: number }): Promise<ActivityEntry[]>;
  listAgents(): Promise<AgentProvider[]>;
  /** Camino IDE → ADE. null si la ruta no pertenece a ningún intento. */
  resolveLocation(ref: LocationRef): Promise<Location | null>;
  /** Único punto de escritura. Rechaza con AdeError (forbidden, unavailable, stale, invalid…). */
  dispatch(intent: Intent): Promise<IntentResult>;
  /** Notifica QUÉ cambió (no los datos); la interfaz invalida y vuelve a preguntar. */
  subscribe(listener: (notice: ChangeNotice) => void): () => void;
}
