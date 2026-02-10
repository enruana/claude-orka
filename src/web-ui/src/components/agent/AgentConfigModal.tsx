/**
 * AgentConfigModal - Modal for creating/editing agents
 */

import { useState, useEffect } from 'react'
import type { Agent, CreateAgentOptions, AgentHookTrigger } from '../../api/agents'

interface AgentConfigModalProps {
  agent?: Agent | null
  isOpen: boolean
  onClose: () => void
  onSave: (options: CreateAgentOptions | Partial<Agent>) => Promise<void>
}

export function AgentConfigModal({ agent, isOpen, onClose, onSave }: AgentConfigModalProps) {
  const [name, setName] = useState('')
  const [masterPrompt, setMasterPrompt] = useState('')
  const [hookEvents, setHookEvents] = useState<AgentHookTrigger[]>(['Stop'])
  const [autoApprove, setAutoApprove] = useState(false)
  const [maxConsecutiveResponses, setMaxConsecutiveResponses] = useState(5)
  const [decisionHistorySize, setDecisionHistorySize] = useState(5)
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setMasterPrompt(agent.masterPrompt)
      setHookEvents(agent.hookEvents)
      setAutoApprove(agent.autoApprove)
      setMaxConsecutiveResponses(agent.maxConsecutiveResponses)
      setDecisionHistorySize(agent.decisionHistorySize ?? 5)
      setTelegramEnabled(agent.notifications.telegram?.enabled || false)
      setTelegramBotToken(agent.notifications.telegram?.botToken || '')
      setTelegramChatId(agent.notifications.telegram?.chatId || '')
    } else {
      // Reset form for new agent
      setName('')
      setMasterPrompt('')
      setHookEvents(['Stop'])
      setAutoApprove(false)
      setMaxConsecutiveResponses(5)
      setDecisionHistorySize(5)
      setTelegramEnabled(false)
      setTelegramBotToken('')
      setTelegramChatId('')
    }
    setError(null)
  }, [agent, isOpen])

  const handleHookEventChange = (event: AgentHookTrigger, checked: boolean) => {
    if (checked) {
      setHookEvents([...hookEvents, event])
    } else {
      setHookEvents(hookEvents.filter(e => e !== event))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)

    try {
      const options: CreateAgentOptions | Partial<Agent> = {
        name,
        masterPrompt,
        hookEvents,
        autoApprove,
        maxConsecutiveResponses,
        decisionHistorySize,
        notifications: {
          telegram: telegramEnabled
            ? {
                enabled: true,
                botToken: telegramBotToken,
                chatId: telegramChatId,
              }
            : { enabled: false },
        },
      }

      await onSave(options)
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="agent-modal-overlay" onClick={onClose}>
      <div className="agent-modal" onClick={e => e.stopPropagation()}>
        <h2>{agent ? 'Edit Agent' : 'Create New Agent'}</h2>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="name">Agent Name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Agent"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="masterPrompt">Master Prompt</label>
            <textarea
              id="masterPrompt"
              value={masterPrompt}
              onChange={e => setMasterPrompt(e.target.value)}
              placeholder="Describe the agent's objective and how it should respond to the Claude Code session..."
              required
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              This prompt guides the agent's decisions when responding to the monitored session.
            </div>
          </div>

          <div className="form-group">
            <label>Hook Events</label>
            <div style={{
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              marginBottom: '8px',
              padding: '8px',
              background: 'var(--bg-tertiary, #313244)',
              borderRadius: '4px',
            }}>
              <strong>Recommended:</strong> Use only <strong>Stop</strong> for most cases.
              Adding multiple hooks can cause the agent to respond multiple times.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="checkbox-group">
                <input
                  type="checkbox"
                  id="hookStop"
                  checked={hookEvents.includes('Stop')}
                  onChange={e => handleHookEventChange('Stop', e.target.checked)}
                />
                <label htmlFor="hookStop">
                  <strong>Stop</strong> - When Claude stops and waits for input
                  <span style={{ color: '#a6e3a1', marginLeft: '8px', fontSize: '0.7rem' }}>✓ Recommended</span>
                </label>
              </div>
              <div className="checkbox-group">
                <input
                  type="checkbox"
                  id="hookSessionStart"
                  checked={hookEvents.includes('SessionStart')}
                  onChange={e => handleHookEventChange('SessionStart', e.target.checked)}
                />
                <label htmlFor="hookSessionStart">
                  <strong>SessionStart</strong> - After compact/clear finishes (to resume work)
                  <span style={{ color: '#f9e2af', marginLeft: '8px', fontSize: '0.7rem' }}>Use with Stop</span>
                </label>
              </div>
              <div style={{ borderTop: '1px solid var(--bg-tertiary, #313244)', margin: '8px 0', paddingTop: '8px' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  Advanced (may cause duplicate responses):
                </div>
              </div>
              <div className="checkbox-group" style={{ opacity: 0.7 }}>
                <input
                  type="checkbox"
                  id="hookNotification"
                  checked={hookEvents.includes('Notification')}
                  onChange={e => handleHookEventChange('Notification', e.target.checked)}
                />
                <label htmlFor="hookNotification">
                  <strong>Notification</strong> - Error notifications
                </label>
              </div>
              <div className="checkbox-group" style={{ opacity: 0.7 }}>
                <input
                  type="checkbox"
                  id="hookSubagentStop"
                  checked={hookEvents.includes('SubagentStop')}
                  onChange={e => handleHookEventChange('SubagentStop', e.target.checked)}
                />
                <label htmlFor="hookSubagentStop">
                  <strong>SubagentStop</strong> - When a Task agent stops
                </label>
              </div>
            </div>
          </div>

          <div className="form-group">
            <div className="checkbox-group">
              <input
                type="checkbox"
                id="autoApprove"
                checked={autoApprove}
                onChange={e => setAutoApprove(e.target.checked)}
              />
              <label htmlFor="autoApprove">Auto-approve tool permissions</label>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="maxResponses">Max Consecutive Responses</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                id="maxResponses"
                type="number"
                value={maxConsecutiveResponses === -1 ? '' : maxConsecutiveResponses}
                onChange={e => {
                  const val = parseInt(e.target.value)
                  if (isNaN(val)) {
                    setMaxConsecutiveResponses(1)
                  } else {
                    setMaxConsecutiveResponses(Math.min(1000, Math.max(1, val)))
                  }
                }}
                min={1}
                max={1000}
                disabled={maxConsecutiveResponses === -1}
                style={{ flex: 1, opacity: maxConsecutiveResponses === -1 ? 0.5 : 1 }}
                placeholder={maxConsecutiveResponses === -1 ? '∞' : ''}
              />
              <button
                type="button"
                onClick={() => setMaxConsecutiveResponses(maxConsecutiveResponses === -1 ? 5 : -1)}
                style={{
                  padding: '8px 12px',
                  background: maxConsecutiveResponses === -1 ? 'var(--accent-color, #89b4fa)' : 'var(--bg-tertiary, #45475a)',
                  color: maxConsecutiveResponses === -1 ? 'var(--bg-primary, #1e1e2e)' : 'var(--text-primary, #cdd6f4)',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '1.2rem',
                  fontWeight: 'bold',
                  minWidth: '44px',
                }}
                title={maxConsecutiveResponses === -1 ? 'Disable infinite mode' : 'Enable infinite mode (no limit)'}
              >
                ∞
              </button>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {maxConsecutiveResponses === -1
                ? 'Infinite mode: Agent will never pause automatically.'
                : 'After this many responses without human input, the agent will pause and notify you.'}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="decisionHistorySize">Decision Memory</label>
            <input
              id="decisionHistorySize"
              type="number"
              value={decisionHistorySize}
              onChange={e => {
                const val = parseInt(e.target.value)
                if (isNaN(val)) {
                  setDecisionHistorySize(1)
                } else {
                  setDecisionHistorySize(Math.min(50, Math.max(1, val)))
                }
              }}
              min={1}
              max={50}
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Number of recent decisions included as context in each AI analysis call. Higher values give more continuity but use more tokens.
            </div>
          </div>

          <div className="form-group">
            <label>Telegram Notifications</label>
            <div className="checkbox-group" style={{ marginBottom: '8px' }}>
              <input
                type="checkbox"
                id="telegramEnabled"
                checked={telegramEnabled}
                onChange={e => setTelegramEnabled(e.target.checked)}
              />
              <label htmlFor="telegramEnabled">Enable Telegram notifications</label>
            </div>
            {telegramEnabled && (
              <>
                <input
                  type="text"
                  value={telegramBotToken}
                  onChange={e => setTelegramBotToken(e.target.value)}
                  placeholder="Bot Token"
                  style={{ marginBottom: '8px' }}
                />
                <input
                  type="text"
                  value={telegramChatId}
                  onChange={e => setTelegramChatId(e.target.value)}
                  placeholder="Chat ID"
                />
              </>
            )}
          </div>

          {error && (
            <div style={{ color: 'var(--color-red)', marginBottom: '16px', fontSize: '0.9rem' }}>
              {error}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="cancel-btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="save-btn" disabled={saving}>
              {saving ? 'Saving...' : agent ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
