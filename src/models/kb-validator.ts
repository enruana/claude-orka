/**
 * Pure validation logic for the Orka KB.
 *
 * Reads the registry (kb-registry.ts) and produces structured ValidationResult
 * objects. No I/O — the manager wires these into mutation paths and decides
 * whether to throw (strict) or record an `entity.flagged` event (draft).
 */

import {
  KB_TYPES,
  KB_STATUSES,
  KB_TRANSITIONS,
  KB_RELATIONS,
  KB_REQUIRED_PROPERTIES,
  PROVENANCE_REQUIRED_RELATIONS,
  isKnownType,
  isKnownRelation,
  isProvenanceBypassActor,
  KBTypeStrict,
} from './kb-registry'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type ValidationMode = 'strict' | 'draft' | 'off'

export type ValidationCode =
  | 'unknown_type'
  | 'invalid_status'
  | 'invalid_transition'
  | 'missing_required_property'
  | 'missing_provenance'
  | 'unknown_relation'
  | 'deprecated_relation'
  | 'invalid_source_type'
  | 'invalid_target_type'

export interface ValidationIssue {
  code: ValidationCode
  severity: 'error' | 'warning'
  message: string
  hint?: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

// --------------------------------------------------------------------------
// Levenshtein "did you mean?"
// --------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[m][n]
}

function suggest(input: string, options: readonly string[], maxDistance = 4): string | undefined {
  let best: string | undefined
  let bestDist = maxDistance + 1
  const inputLower = input.toLowerCase()
  for (const opt of options) {
    const d = levenshtein(inputLower, opt.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = opt
    }
  }
  return best
}

// --------------------------------------------------------------------------
// Result builder
// --------------------------------------------------------------------------

function buildResult(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { ok: errors.length === 0, errors, warnings }
}

// --------------------------------------------------------------------------
// Entity creation validation
// --------------------------------------------------------------------------

export interface ValidateEntityCreationInput {
  type: string
  status: string
  properties: Record<string, unknown>
  edges: Array<{ relation: string; target: string }>
  actor: string
}

export function validateEntityCreation(input: ValidateEntityCreationInput): ValidationResult {
  const issues: ValidationIssue[] = []

  // 1. Type must be known
  if (!isKnownType(input.type)) {
    const hint = suggest(input.type, KB_TYPES)
    issues.push({
      code: 'unknown_type',
      severity: 'error',
      message: `Unknown entity type "${input.type}".`,
      hint: hint
        ? `Did you mean "${hint}"? Valid types: ${KB_TYPES.join(', ')}`
        : `Valid types: ${KB_TYPES.join(', ')}`,
    })
    // No further checks — without a known type we can't validate status/properties.
    return buildResult(issues)
  }

  const type = input.type as KBTypeStrict

  // 2. Status must be in the per-type allowed set
  const allowedStatuses = KB_STATUSES[type]
  if (!allowedStatuses.includes(input.status)) {
    const hint = suggest(input.status, allowedStatuses)
    issues.push({
      code: 'invalid_status',
      severity: 'error',
      message: `Invalid status "${input.status}" for type "${type}".`,
      hint: hint
        ? `Did you mean "${hint}"? Valid: ${allowedStatuses.join(', ')}`
        : `Valid: ${allowedStatuses.join(', ')}`,
    })
  }

  // 3. Required properties
  const required = KB_REQUIRED_PROPERTIES[type] || []
  for (const prop of required) {
    const v = input.properties[prop]
    const present = v !== undefined && v !== null && !(typeof v === 'string' && !v.trim())
    if (!present) {
      issues.push({
        code: 'missing_required_property',
        severity: 'error',
        message: `Type "${type}" requires property "${prop}".`,
        hint: `Pass --property ${prop}="..." when creating.`,
      })
    }
  }

  // 4. Provenance: non-cli actors must link to a source/activity/derivation
  if (!isProvenanceBypassActor(input.actor)) {
    const hasProvenance = input.edges.some((e) =>
      (PROVENANCE_REQUIRED_RELATIONS as readonly string[]).includes(e.relation)
    )
    if (!hasProvenance) {
      issues.push({
        code: 'missing_provenance',
        severity: 'error',
        message: `Entities created by "${input.actor}" must include at least one provenance edge.`,
        hint: `Add --link sourced-from:<meeting/artifact/context-id> or --link generated-by:<activity-id>.`,
      })
    }
  }

  return buildResult(issues)
}

// --------------------------------------------------------------------------
// Entity update validation
// --------------------------------------------------------------------------

export interface ValidateEntityUpdateInput {
  type: string
  fromStatus: string
  toStatus?: string
  newProperties?: Record<string, unknown>
}

export function validateEntityUpdate(input: ValidateEntityUpdateInput): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!isKnownType(input.type)) {
    // The entity already exists with this type — soft-warn, don't block.
    issues.push({
      code: 'unknown_type',
      severity: 'warning',
      message: `Entity has unknown type "${input.type}" — existing pre-v2 entity. Migrate via 'orka kb upgrade'.`,
    })
    return buildResult(issues)
  }

  const type = input.type as KBTypeStrict

  // Status check
  if (input.toStatus && input.toStatus !== input.fromStatus) {
    const allowedStatuses = KB_STATUSES[type]
    if (!allowedStatuses.includes(input.toStatus)) {
      const hint = suggest(input.toStatus, allowedStatuses)
      issues.push({
        code: 'invalid_status',
        severity: 'error',
        message: `Invalid status "${input.toStatus}" for type "${type}".`,
        hint: hint
          ? `Did you mean "${hint}"? Valid: ${allowedStatuses.join(', ')}`
          : `Valid: ${allowedStatuses.join(', ')}`,
      })
    } else {
      // Transition check (if a state machine is defined for this type)
      const transitions = KB_TRANSITIONS[type]
      if (transitions) {
        const allowed = transitions[input.fromStatus]
        if (allowed && !allowed.includes(input.toStatus)) {
          issues.push({
            code: 'invalid_transition',
            severity: 'error',
            message: `Invalid transition "${input.fromStatus}" → "${input.toStatus}" for type "${type}".`,
            hint:
              allowed.length > 0
                ? `From "${input.fromStatus}", you can move to: ${allowed.join(', ')}.`
                : `Status "${input.fromStatus}" is terminal — create a new entity that supersedes this one.`,
          })
        }
      }
    }
  }

  return buildResult(issues)
}

// --------------------------------------------------------------------------
// Edge validation
// --------------------------------------------------------------------------

export interface ValidateEdgeInput {
  sourceType: string
  relation: string
  targetType: string
}

export function validateEdge(input: ValidateEdgeInput): ValidationResult {
  const issues: ValidationIssue[] = []

  if (!isKnownRelation(input.relation)) {
    const hint = suggest(input.relation, Object.keys(KB_RELATIONS))
    issues.push({
      code: 'unknown_relation',
      severity: 'error',
      message: `Unknown relation "${input.relation}".`,
      hint: hint
        ? `Did you mean "${hint}"? See 'orka kb relations' for the full list.`
        : `See 'orka kb relations' for the full list.`,
    })
    return buildResult(issues)
  }

  const def = KB_RELATIONS[input.relation]

  if (def.deprecated) {
    issues.push({
      code: 'deprecated_relation',
      severity: 'warning',
      message: `Relation "${input.relation}" is deprecated.`,
      hint: def.migrationHint || 'Migrate to a typed relation.',
    })
  }

  // Source-type constraint
  if (def.source !== '*') {
    if (!isKnownType(input.sourceType)) {
      issues.push({
        code: 'invalid_source_type',
        severity: 'warning',
        message: `Source entity has unknown type "${input.sourceType}" — cannot validate constraints.`,
      })
    } else if (!def.source.includes(input.sourceType as KBTypeStrict)) {
      issues.push({
        code: 'invalid_source_type',
        severity: 'error',
        message: `Relation "${input.relation}" cannot start from type "${input.sourceType}".`,
        hint: `Allowed sources: ${def.source.join(', ')}.`,
      })
    }
  }

  // Target-type constraint
  if (def.target !== '*') {
    if (!isKnownType(input.targetType)) {
      issues.push({
        code: 'invalid_target_type',
        severity: 'warning',
        message: `Target entity has unknown type "${input.targetType}" — cannot validate constraints.`,
      })
    } else if (!def.target.includes(input.targetType as KBTypeStrict)) {
      issues.push({
        code: 'invalid_target_type',
        severity: 'error',
        message: `Relation "${input.relation}" cannot point to type "${input.targetType}".`,
        hint: `Allowed targets: ${def.target.join(', ')}.`,
      })
    }
  }

  return buildResult(issues)
}

// --------------------------------------------------------------------------
// Formatting helpers (for CLI output)
// --------------------------------------------------------------------------

export function formatIssue(issue: ValidationIssue): string {
  const tag = issue.severity === 'error' ? '✗' : '⚠'
  const hint = issue.hint ? `\n     ${issue.hint}` : ''
  return `  ${tag} [${issue.code}] ${issue.message}${hint}`
}

export function formatResult(result: ValidationResult): string {
  const lines: string[] = []
  for (const e of result.errors) lines.push(formatIssue(e))
  for (const w of result.warnings) lines.push(formatIssue(w))
  return lines.join('\n')
}
