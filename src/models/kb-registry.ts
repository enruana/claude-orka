/**
 * Orka KB Registry — single source of truth for the KB schema.
 *
 * This file defines the closed vocabularies that every other piece of the system
 * (CLI, validator, manager, UI) reads from. Adding a type, a status, or a
 * relation is intentionally a code change — it forces review and prevents the
 * silent drift seen in v1 (rogue "reference" type, "completed"/"answered"
 * statuses, ad-hoc relations).
 *
 * Versioned: bump KB_SCHEMA_VERSION when the registry changes in a way that
 * requires migration of existing entity files.
 */

// --------------------------------------------------------------------------
// Schema version
// --------------------------------------------------------------------------

export const KB_SCHEMA_VERSION = 2

// --------------------------------------------------------------------------
// Types — closed enum
// --------------------------------------------------------------------------

/**
 * Three tiers of entities:
 *   1. Work tier   — goal, initiative, project, task, spike, bug
 *   2. Knowledge   — decision, question, meeting, milestone, direction
 *   3. Reference   — person, repo, artifact, context
 *   4. Provenance  — activity (PROV-O: a skill/agent run that produced entities)
 */
export const KB_TYPES = [
  // Work tier
  'goal',
  'initiative',
  'project',
  'task',
  'spike',
  'bug',
  // Knowledge tier
  'decision',
  'question',
  'meeting',
  'milestone',
  'direction',
  // Reference tier
  'person',
  'repo',
  'artifact',
  'context',
  // Provenance
  'activity',
] as const

export type KBTypeStrict = typeof KB_TYPES[number]

export const KB_WORK_TYPES: KBTypeStrict[] = ['goal', 'initiative', 'project', 'task', 'spike', 'bug']
export const KB_KNOWLEDGE_TYPES: KBTypeStrict[] = ['decision', 'question', 'meeting', 'milestone', 'direction']
export const KB_REFERENCE_TYPES: KBTypeStrict[] = ['person', 'repo', 'artifact', 'context']

// --------------------------------------------------------------------------
// ID prefixes
// --------------------------------------------------------------------------

export const KB_TYPE_PREFIXES: Record<KBTypeStrict, string> = {
  goal: 'gol',
  initiative: 'ini',
  project: 'prj',
  task: 'tsk',
  spike: 'spk',
  bug: 'bug',
  decision: 'dec',
  question: 'qst',
  meeting: 'mtg',
  milestone: 'mil',
  direction: 'dir',
  person: 'per',
  repo: 'rep',
  artifact: 'art',
  context: 'ctx',
  activity: 'act',
}

// --------------------------------------------------------------------------
// Statuses — closed enum per type
// --------------------------------------------------------------------------

/**
 * Allowed statuses per type. The first value in each list is the default
 * status for newly created entities of that type.
 *
 * For backward compat with v1 KBs, several types accept legacy statuses
 * (e.g. project: 'in-progress', 'blocked', 'review'). Migration in P9
 * normalizes these.
 */
export const KB_STATUSES: Record<KBTypeStrict, readonly string[]> = {
  // Work tier
  goal: ['active', 'archived'],
  initiative: ['active', 'archived'],
  project: ['planning', 'active', 'in-progress', 'blocked', 'review', 'done', 'cancelled', 'archived'],
  task: ['todo', 'in-progress', 'done', 'blocked', 'cancelled'],
  spike: ['open', 'in-progress', 'concluded', 'cancelled'],
  bug: ['open', 'investigating', 'fixed', 'wontfix', 'duplicate'],
  // Knowledge tier
  decision: ['proposed', 'accepted', 'rejected', 'superseded'],
  question: ['open', 'active', 'answered', 'resolved', 'closed'],
  meeting: ['scheduled', 'held', 'archived'],
  milestone: ['active', 'reached', 'resolved', 'archived'],
  direction: ['active', 'archived'],
  // Reference tier
  person: ['active', 'archived', 'superseded'],
  repo: ['active', 'archived'],
  artifact: ['draft', 'active', 'archived', 'superseded'],
  context: ['active', 'archived'],
  // Provenance
  activity: ['active'],
}

// --------------------------------------------------------------------------
// State-machine transitions
// --------------------------------------------------------------------------

/**
 * Allowed status transitions. If a type is omitted, all transitions among its
 * valid statuses are allowed (lenient).
 *
 * Decisions follow the ADR pattern: immutable after acceptance — the only
 * "edit" path is to create a new decision that supersedes the old one.
 */
export const KB_TRANSITIONS: Partial<Record<KBTypeStrict, Record<string, readonly string[]>>> = {
  decision: {
    proposed: ['accepted', 'rejected'],
    accepted: ['superseded'],
    rejected: [],
    superseded: [],
  },
  question: {
    open: ['active', 'answered', 'resolved', 'closed'],
    active: ['answered', 'resolved', 'closed'],
    answered: ['resolved', 'closed'],
    resolved: ['closed'],
    closed: [],
  },
  milestone: {
    active: ['reached', 'archived'],
    reached: ['archived'],
    resolved: ['archived'],
    archived: [],
  },
  bug: {
    open: ['investigating', 'wontfix', 'duplicate'],
    investigating: ['fixed', 'wontfix', 'duplicate', 'open'],
    fixed: [],
    wontfix: ['investigating'],
    duplicate: [],
  },
}

// --------------------------------------------------------------------------
// Relations — vocabulary with type constraints
// --------------------------------------------------------------------------

export interface RelationDef {
  /** Allowed source entity types, or '*' for any. */
  source: KBTypeStrict[] | '*'
  /** Allowed target entity types, or '*' for any. */
  target: KBTypeStrict[] | '*'
  /** Human-readable description for tooling and skill prompts. */
  description: string
  /** Deprecated relations stay readable but emit a warning on creation. */
  deprecated?: boolean
  /** Migration hint shown when a deprecated relation is used. */
  migrationHint?: string
}

/**
 * The relation vocabulary. Adding a relation is intentionally a code change.
 * Source/target type constraints are enforced by the validator.
 */
export const KB_RELATIONS: Record<string, RelationDef> = {
  // -------- Hierarchy / decomposition --------
  'subtask-of': {
    source: ['task'],
    target: ['task', 'spike', 'bug'],
    description: 'Task is a sub-task of another work item (Linear-style sub-issue).',
  },
  'scope-of': {
    source: ['task', 'spike'],
    target: ['project'],
    description: 'Task or spike is a scope (vertical slice) of a project (Shape Up).',
  },
  'child-of': {
    source: ['project', 'initiative', 'bug', 'spike'],
    target: ['initiative', 'goal', 'project'],
    description: 'Strategic hierarchy: project→initiative, initiative→goal, bug→project.',
  },

  // -------- Knowledge → work --------
  'addresses': {
    source: ['decision', 'project', 'task', 'spike'],
    target: ['question', 'direction'],
    description: 'This work item or decision addresses a question or direction.',
  },
  'answers': {
    source: ['decision', 'artifact', 'meeting', 'spike'],
    target: ['question'],
    description: 'This entity provides the answer to a question.',
  },
  'implements': {
    source: ['project', 'task', 'initiative'],
    target: ['direction', 'decision'],
    description: 'This work item implements a strategic direction or accepted decision.',
  },

  // -------- Knowledge ↔ meeting --------
  'decided-at': {
    source: ['decision'],
    target: ['meeting'],
    description: 'Decision was made during this meeting.',
  },
  'raised-at': {
    source: ['question'],
    target: ['meeting'],
    description: 'Question was raised during this meeting.',
  },
  'attended-by': {
    source: ['meeting'],
    target: ['person'],
    description: 'Person attended this meeting.',
  },

  // -------- Lifecycle --------
  'blocks': {
    source: KB_WORK_TYPES,
    target: KB_WORK_TYPES,
    description: 'This work item is blocking another work item.',
  },
  'depends-on': {
    source: KB_WORK_TYPES,
    target: KB_WORK_TYPES,
    description: 'This work item depends on another work item.',
  },
  'supersedes': {
    source: ['decision', 'project', 'artifact'],
    target: ['decision', 'project', 'artifact'],
    description: 'This entity replaces a previous one (ADR supersession pattern).',
  },

  // -------- Provenance (PROV-O) --------
  'sourced-from': {
    source: '*',
    target: ['meeting', 'artifact', 'context'],
    description: 'PROV-O: this entity was sourced from a meeting, artifact, or prior context.',
  },
  'generated-by': {
    source: '*',
    target: ['activity'],
    description: 'PROV-O wasGeneratedBy: which skill/agent run produced this entity.',
  },
  'derived-from': {
    source: '*',
    target: '*',
    description: 'PROV-O wasDerivedFrom: this entity was derived from another entity.',
  },
  'attributed-to': {
    source: '*',
    target: ['person'],
    description: 'PROV-O wasAttributedTo: human responsible for this entity.',
  },

  // -------- Categorical / catch-all --------
  'relates-to': {
    source: '*',
    target: '*',
    description: 'Generic, deliberately-vague connection. Use a typed relation when possible.',
  },
  'assigned-to': {
    source: KB_WORK_TYPES,
    target: ['person'],
    description: 'Person is assigned to this work item.',
  },
  'references': {
    source: '*',
    target: '*',
    description: 'This entity references another (loose link, e.g. for cross-references).',
  },
  'owned-by': {
    source: [...KB_WORK_TYPES, 'repo', 'artifact'],
    target: ['person'],
    description: 'Single accountable owner for this entity.',
  },

  // -------- Deprecated — handled in P9 migration --------
  'part-of': {
    source: '*',
    target: '*',
    description: '[deprecated] Polysemic legacy relation — split into subtask-of/scope-of/child-of/sourced-from.',
    deprecated: true,
    migrationHint: 'Use subtask-of, scope-of, child-of, sourced-from, or owned-by depending on the semantic.',
  },
  'contributes-to': {
    source: ['person'],
    target: '*',
    description: '[deprecated] Use attributed-to or assigned-to.',
    deprecated: true,
    migrationHint: 'Use attributed-to (provenance) or assigned-to (active work).',
  },
}

// --------------------------------------------------------------------------
// Required properties per type
// --------------------------------------------------------------------------

/**
 * Properties that must be present (and non-empty) when creating an entity
 * of this type. The validator enforces this in 'strict' mode.
 *
 * Decisions follow MADR — `outcome` is the single most-important field
 * (the chosen option). `drivers`, `options`, and `consequences` are strongly
 * recommended (see KB_RECOMMENDED_PROPERTIES) but not strictly required at
 * the validator level — skills are where the rich structure is enforced.
 */
export const KB_REQUIRED_PROPERTIES: Partial<Record<KBTypeStrict, readonly string[]>> = {
  goal: ['description'],
  initiative: ['description'],
  project: ['description'],
  task: ['description'],
  spike: ['description'],
  bug: ['description'],
  decision: ['description', 'outcome'],
  direction: ['description'],
  meeting: ['date'],
  // question: title IS the question — no required properties
  // milestone, person, repo, artifact, context, activity: title sufficient
}

/**
 * Properties that are strongly recommended for each type — surfaced in
 * skill prompts and the UI. Not enforced by the validator (yet), but
 * `kb lint` flags missing recommended properties as warnings.
 */
export const KB_RECOMMENDED_PROPERTIES: Partial<Record<KBTypeStrict, readonly string[]>> = {
  goal: ['owner', 'rationale'],
  initiative: ['owner', 'target_release', 'description'],
  project: ['path', 'owner', 'target_release', 'repo_path'],
  task: ['owner', 'estimate', 'priority'],
  spike: ['question', 'time_box', 'owner'],
  bug: ['repro_steps', 'severity', 'reporter'],
  // MADR: full structure for decisions
  decision: ['drivers', 'options', 'consequences', 'decided_by', 'decided_at'],
  question: ['priority', 'to_resolve_with'],
  meeting: ['attendees', 'notes_path'],
  milestone: ['target', 'criteria'],
  direction: ['rationale', 'horizon'],
  person: ['role', 'profile_path'],
  repo: ['stack', 'url'],
  artifact: ['path', 'kind'],
  context: ['path', 'audience'],
  activity: ['skill', 'session_id', 'inputs'],
}

// --------------------------------------------------------------------------
// Provenance requirements
// --------------------------------------------------------------------------

/**
 * Actors that don't require provenance edges. Anything else (skill/agent
 * actors like 'skill:kb-track', 'agent:claude') must link the entity to a
 * source artifact/meeting/context or generating activity.
 */
export const PROVENANCE_BYPASS_ACTORS = new Set(['cli', 'migration', 'system'])

/**
 * For non-bypass actors, at least one edge with one of these relations must
 * be present at entity creation time.
 */
export const PROVENANCE_REQUIRED_RELATIONS: readonly string[] = [
  'sourced-from',
  'generated-by',
  'derived-from',
]

export function isProvenanceBypassActor(actor: string): boolean {
  return PROVENANCE_BYPASS_ACTORS.has(actor)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export function isKnownType(type: string): type is KBTypeStrict {
  return (KB_TYPES as readonly string[]).includes(type)
}

export function isKnownRelation(relation: string): boolean {
  return relation in KB_RELATIONS
}

export function defaultStatusForType(type: KBTypeStrict): string {
  return KB_STATUSES[type][0]
}
