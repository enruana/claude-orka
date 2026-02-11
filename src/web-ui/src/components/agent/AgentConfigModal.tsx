/**
 * AgentConfigModal - Modal for creating/editing agents with tabbed layout
 */

import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, Eye, Pencil, Plus, Trash2, Check } from 'lucide-react'
import { agentsApi } from '../../api/agents'
import type { Agent, CreateAgentOptions, AgentHookTrigger, PromptRole } from '../../api/agents'

interface AgentConfigModalProps {
  agent?: Agent | null
  isOpen: boolean
  onClose: () => void
  onSave: (options: CreateAgentOptions | Partial<Agent>) => Promise<void>
}

type TabId = 'config' | 'prompt'

let roleIdCounter = 0
function generateRoleId(): string {
  return `role-${Date.now()}-${++roleIdCounter}`
}

export function AgentConfigModal({ agent, isOpen, onClose, onSave }: AgentConfigModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('config')
  const [name, setName] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [hookEvents, setHookEvents] = useState<AgentHookTrigger[]>(['Stop'])
  const [autoApprove, setAutoApprove] = useState(false)
  const [maxConsecutiveResponses, setMaxConsecutiveResponses] = useState(5)
  const [decisionHistorySize, setDecisionHistorySize] = useState(5)
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramChatId, setTelegramChatId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prompt tab state
  const [promptView, setPromptView] = useState<'edit' | 'preview'>('edit')
  const [isImproving, setIsImproving] = useState(false)
  const [improveError, setImproveError] = useState<string | null>(null)
  const [improveInstructions, setImproveInstructions] = useState('')

  // Roles state
  const [roles, setRoles] = useState<PromptRole[]>([])
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null)
  const [editingRoleName, setEditingRoleName] = useState<string | null>(null) // role id being renamed
  const [renameValue, setRenameValue] = useState('')

  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setCustomPrompt(agent.masterPrompt)
      setHookEvents(agent.hookEvents)
      setAutoApprove(agent.autoApprove)
      setMaxConsecutiveResponses(agent.maxConsecutiveResponses)
      setDecisionHistorySize(agent.decisionHistorySize ?? 5)
      setTelegramEnabled(agent.notifications.telegram?.enabled || false)
      setTelegramBotToken(agent.notifications.telegram?.botToken || '')
      setTelegramChatId(agent.notifications.telegram?.chatId || '')
      setRoles(agent.promptRoles || [])
      setActiveRoleId(agent.activeRoleId || null)
    } else {
      setName('')
      setCustomPrompt('')
      setHookEvents(['Stop'])
      setAutoApprove(false)
      setMaxConsecutiveResponses(5)
      setDecisionHistorySize(5)
      setTelegramEnabled(false)
      setTelegramBotToken('')
      setTelegramChatId('')
      setRoles([])
      setActiveRoleId(null)
    }
    setError(null)
    setImproveError(null)
    setActiveTab('config')
    setPromptView('edit')
    setEditingRoleName(null)
  }, [agent, isOpen])

  const handleHookEventChange = (event: AgentHookTrigger, checked: boolean) => {
    if (checked) {
      setHookEvents([...hookEvents, event])
    } else {
      setHookEvents(hookEvents.filter(e => e !== event))
    }
  }

  // --- Derived prompt: read/write from the correct source ---

  const currentPrompt = activeRoleId
    ? (roles.find(r => r.id === activeRoleId)?.prompt ?? '')
    : customPrompt

  const setCurrentPrompt = (value: string) => {
    if (activeRoleId) {
      setRoles(prev => prev.map(r => r.id === activeRoleId ? { ...r, prompt: value } : r))
    } else {
      setCustomPrompt(value)
    }
  }

  // --- Role management ---

  const handleSaveCurrentAsRole = () => {
    if (!currentPrompt.trim()) return
    const newRole: PromptRole = {
      id: generateRoleId(),
      name: 'New Role',
      prompt: currentPrompt,
    }
    const updated = [...roles, newRole]
    setRoles(updated)
    setActiveRoleId(newRole.id)
    // Immediately start renaming
    setEditingRoleName(newRole.id)
    setRenameValue('New Role')
  }

  const handleSelectRole = (roleId: string) => {
    setActiveRoleId(roleId)
  }

  const handleDeselectRole = () => {
    setActiveRoleId(null)
  }

  const handleDeleteRole = (roleId: string) => {
    setRoles(prev => prev.filter(r => r.id !== roleId))
    if (activeRoleId === roleId) {
      setActiveRoleId(null)
    }
  }

  const handleRenameRole = (roleId: string) => {
    if (!renameValue.trim()) return
    setRoles(prev => prev.map(r => r.id === roleId ? { ...r, name: renameValue.trim() } : r))
    setEditingRoleName(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)

    try {
      const options: CreateAgentOptions | Partial<Agent> = {
        name,
        masterPrompt: customPrompt,
        hookEvents,
        autoApprove,
        maxConsecutiveResponses,
        decisionHistorySize,
        promptRoles: roles.length > 0 ? roles : undefined,
        activeRoleId: activeRoleId || undefined,
        notifications: {
          telegram: telegramEnabled
            ? { enabled: true, botToken: telegramBotToken, chatId: telegramChatId }
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

  const handleImprovePrompt = async () => {
    if (!currentPrompt.trim()) {
      setImproveError('Write a prompt first before improving it.')
      return
    }
    setIsImproving(true)
    setImproveError(null)
    try {
      const improved = await agentsApi.improvePrompt(currentPrompt, improveInstructions.trim() || undefined)
      setCurrentPrompt(improved)
      setImproveInstructions('')
      setPromptView('preview')
    } catch (err: any) {
      setImproveError(err.message)
    } finally {
      setIsImproving(false)
    }
  }

  if (!isOpen) return null

  const tabs: { id: TabId; label: string }[] = [
    { id: 'config', label: 'Configuration' },
    { id: 'prompt', label: 'Master Prompt' },
  ]

  return (
    <div className="agent-modal-overlay" onClick={onClose}>
      <div
        className="agent-modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '700px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        {/* Header */}
        <div style={{ padding: '20px 24px 0' }}>
          <h2 style={{ margin: '0 0 16px 0' }}>{agent ? 'Edit Agent' : 'Create New Agent'}</h2>
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border-color, #313244)' }}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: activeTab === tab.id ? '2px solid var(--accent-color, #89b4fa)' : '2px solid transparent',
                  padding: '10px 20px',
                  cursor: 'pointer',
                  color: activeTab === tab.id ? 'var(--accent-color, #89b4fa)' : 'var(--text-secondary, #6c7086)',
                  fontSize: '0.9rem',
                  fontWeight: activeTab === tab.id ? 600 : 400,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

            {/* === CONFIG TAB === */}
            {activeTab === 'config' && (
              <>
                <div className="form-group">
                  <label htmlFor="name">Agent Name</label>
                  <input id="name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="My Agent" required />
                </div>

                <div className="form-group">
                  <label>Hook Events</label>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '8px', padding: '8px', background: 'var(--bg-tertiary, #313244)', borderRadius: '4px' }}>
                    <strong>Recommended:</strong> Use only <strong>Stop</strong> for most cases.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div className="checkbox-group">
                      <input type="checkbox" id="hookStop" checked={hookEvents.includes('Stop')} onChange={e => handleHookEventChange('Stop', e.target.checked)} />
                      <label htmlFor="hookStop"><strong>Stop</strong> - When Claude stops and waits for input <span style={{ color: '#a6e3a1', marginLeft: '8px', fontSize: '0.7rem' }}>Recommended</span></label>
                    </div>
                    <div className="checkbox-group">
                      <input type="checkbox" id="hookSessionStart" checked={hookEvents.includes('SessionStart')} onChange={e => handleHookEventChange('SessionStart', e.target.checked)} />
                      <label htmlFor="hookSessionStart"><strong>SessionStart</strong> - After compact/clear finishes <span style={{ color: '#f9e2af', marginLeft: '8px', fontSize: '0.7rem' }}>Use with Stop</span></label>
                    </div>
                    <div style={{ borderTop: '1px solid var(--bg-tertiary, #313244)', margin: '8px 0', paddingTop: '8px' }}>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>Advanced (may cause duplicate responses):</div>
                    </div>
                    <div className="checkbox-group" style={{ opacity: 0.7 }}>
                      <input type="checkbox" id="hookNotification" checked={hookEvents.includes('Notification')} onChange={e => handleHookEventChange('Notification', e.target.checked)} />
                      <label htmlFor="hookNotification"><strong>Notification</strong> - Error notifications</label>
                    </div>
                    <div className="checkbox-group" style={{ opacity: 0.7 }}>
                      <input type="checkbox" id="hookSubagentStop" checked={hookEvents.includes('SubagentStop')} onChange={e => handleHookEventChange('SubagentStop', e.target.checked)} />
                      <label htmlFor="hookSubagentStop"><strong>SubagentStop</strong> - When a Task agent stops</label>
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <div className="checkbox-group">
                    <input type="checkbox" id="autoApprove" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
                    <label htmlFor="autoApprove">Auto-approve tool permissions</label>
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="maxResponses">Max Consecutive Responses</label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input id="maxResponses" type="number" value={maxConsecutiveResponses === -1 ? '' : maxConsecutiveResponses} onChange={e => { const v = parseInt(e.target.value); setMaxConsecutiveResponses(isNaN(v) ? 1 : Math.min(1000, Math.max(1, v))) }} min={1} max={1000} disabled={maxConsecutiveResponses === -1} style={{ flex: 1, opacity: maxConsecutiveResponses === -1 ? 0.5 : 1 }} placeholder={maxConsecutiveResponses === -1 ? '∞' : ''} />
                    <button type="button" onClick={() => setMaxConsecutiveResponses(maxConsecutiveResponses === -1 ? 5 : -1)} style={{ padding: '8px 12px', background: maxConsecutiveResponses === -1 ? 'var(--accent-color, #89b4fa)' : 'var(--bg-tertiary, #45475a)', color: maxConsecutiveResponses === -1 ? 'var(--bg-primary, #1e1e2e)' : 'var(--text-primary, #cdd6f4)', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '1.2rem', fontWeight: 'bold', minWidth: '44px' }} title={maxConsecutiveResponses === -1 ? 'Disable infinite mode' : 'Enable infinite mode'}>∞</button>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {maxConsecutiveResponses === -1 ? 'Infinite mode: Agent will never pause automatically.' : 'After this many responses, the agent will pause.'}
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="decisionHistorySize">Decision Memory</label>
                  <input id="decisionHistorySize" type="number" value={decisionHistorySize} onChange={e => { const v = parseInt(e.target.value); setDecisionHistorySize(isNaN(v) ? 1 : Math.min(50, Math.max(1, v))) }} min={1} max={50} />
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>Recent decisions included as context per analysis. Higher = more tokens.</div>
                </div>

                <div className="form-group">
                  <label>Telegram Notifications</label>
                  <div className="checkbox-group" style={{ marginBottom: '8px' }}>
                    <input type="checkbox" id="telegramEnabled" checked={telegramEnabled} onChange={e => setTelegramEnabled(e.target.checked)} />
                    <label htmlFor="telegramEnabled">Enable Telegram notifications</label>
                  </div>
                  {telegramEnabled && (
                    <>
                      <input type="text" value={telegramBotToken} onChange={e => setTelegramBotToken(e.target.value)} placeholder="Bot Token" style={{ marginBottom: '8px' }} />
                      <input type="text" value={telegramChatId} onChange={e => setTelegramChatId(e.target.value)} placeholder="Chat ID" />
                    </>
                  )}
                </div>
              </>
            )}

            {/* === PROMPT TAB === */}
            {activeTab === 'prompt' && (
              <>
                {/* Roles bar */}
                <div style={{
                  display: 'flex',
                  gap: '6px',
                  marginBottom: '12px',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}>
                  {/* "No role" / custom chip */}
                  <button
                    type="button"
                    onClick={handleDeselectRole}
                    style={{
                      padding: '5px 12px',
                      borderRadius: '16px',
                      border: !activeRoleId ? '2px solid var(--accent-color, #89b4fa)' : '1px solid var(--border-color, #313244)',
                      background: !activeRoleId ? 'rgba(137, 180, 250, 0.15)' : 'var(--bg-tertiary, #11111b)',
                      color: !activeRoleId ? 'var(--accent-color, #89b4fa)' : 'var(--text-secondary, #6c7086)',
                      cursor: 'pointer',
                      fontSize: '0.78rem',
                      fontWeight: !activeRoleId ? 600 : 400,
                    }}
                  >
                    Custom
                  </button>

                  {/* Role chips */}
                  {roles.map(role => {
                    const isActive = activeRoleId === role.id
                    const isRenaming = editingRoleName === role.id
                    return (
                      <div key={role.id} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                        {isRenaming ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                            <input
                              type="text"
                              value={renameValue}
                              onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleRenameRole(role.id) } if (e.key === 'Escape') setEditingRoleName(null) }}
                              autoFocus
                              style={{
                                width: '120px',
                                padding: '4px 8px',
                                borderRadius: '12px',
                                border: '2px solid var(--accent-color, #89b4fa)',
                                background: 'var(--bg-tertiary, #11111b)',
                                color: 'var(--text-primary, #cdd6f4)',
                                fontSize: '0.78rem',
                              }}
                            />
                            <button type="button" onClick={() => handleRenameRole(role.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#a6e3a1', padding: '2px' }}>
                              <Check size={14} />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSelectRole(role.id)}
                            onDoubleClick={() => { setEditingRoleName(role.id); setRenameValue(role.name) }}
                            style={{
                              padding: '5px 12px',
                              borderRadius: '16px',
                              border: isActive ? '2px solid #cba6f7' : '1px solid var(--border-color, #313244)',
                              background: isActive ? 'rgba(203, 166, 247, 0.15)' : 'var(--bg-tertiary, #11111b)',
                              color: isActive ? '#cba6f7' : 'var(--text-secondary, #a6adc8)',
                              cursor: 'pointer',
                              fontSize: '0.78rem',
                              fontWeight: isActive ? 600 : 400,
                            }}
                            title="Click to switch, double-click to rename"
                          >
                            {role.name}
                          </button>
                        )}
                        {/* Delete role */}
                        {!isRenaming && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id) }}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6c7086', padding: '2px', opacity: 0.6 }}
                            title="Delete role"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    )
                  })}

                  {/* Add role button */}
                  <button
                    type="button"
                    onClick={handleSaveCurrentAsRole}
                    style={{
                      padding: '5px 10px',
                      borderRadius: '16px',
                      border: '1px dashed var(--border-color, #313244)',
                      background: 'transparent',
                      color: 'var(--text-secondary, #6c7086)',
                      cursor: 'pointer',
                      fontSize: '0.78rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                    title="Save current prompt as a new role"
                  >
                    <Plus size={12} /> Role
                  </button>
                </div>

                {/* Toolbar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', background: 'var(--bg-tertiary, #11111b)', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border-color, #313244)' }}>
                    <button type="button" onClick={() => setPromptView('edit')} style={{ background: promptView === 'edit' ? 'var(--accent-color, #89b4fa)' : 'transparent', color: promptView === 'edit' ? 'var(--bg-primary, #1e1e2e)' : 'var(--text-secondary, #6c7086)', border: 'none', padding: '6px 12px', cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Pencil size={12} /> Edit
                    </button>
                    <button type="button" onClick={() => setPromptView('preview')} style={{ background: promptView === 'preview' ? 'var(--accent-color, #89b4fa)' : 'transparent', color: promptView === 'preview' ? 'var(--bg-primary, #1e1e2e)' : 'var(--text-secondary, #6c7086)', border: 'none', padding: '6px 12px', cursor: 'pointer', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Eye size={12} /> Preview
                    </button>
                  </div>
                </div>

                {/* Improve with AI bar */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', alignItems: 'center' }}>
                  <Sparkles size={14} style={{ color: '#cba6f7', flexShrink: 0 }} />
                  <input
                    type="text"
                    value={improveInstructions}
                    onChange={e => setImproveInstructions(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleImprovePrompt() } }}
                    placeholder="Instructions: e.g. 'add error handling', 'make more concise'..."
                    disabled={isImproving}
                    style={{ flex: 1, padding: '7px 10px', background: 'var(--bg-tertiary, #11111b)', border: '1px solid var(--border-color, #313244)', borderRadius: '6px', color: 'var(--text-primary, #cdd6f4)', fontSize: '0.8rem' }}
                  />
                  <button
                    type="button"
                    onClick={handleImprovePrompt}
                    disabled={isImproving || !currentPrompt.trim()}
                    style={{ background: isImproving ? 'var(--bg-tertiary, #45475a)' : 'linear-gradient(135deg, #cba6f7, #89b4fa)', color: '#1e1e2e', border: 'none', borderRadius: '6px', padding: '7px 14px', cursor: isImproving ? 'wait' : 'pointer', fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0, opacity: !currentPrompt.trim() ? 0.4 : 1 }}
                  >
                    <Sparkles size={13} style={{ animation: isImproving ? 'spin 1s linear infinite' : 'none' }} />
                    {isImproving ? 'Improving...' : 'Improve'}
                  </button>
                </div>

                {improveError && (
                  <div style={{ padding: '8px 12px', background: 'rgba(243, 139, 168, 0.1)', borderRadius: '6px', color: '#f38ba8', fontSize: '0.8rem', marginBottom: '12px' }}>
                    {improveError}
                  </div>
                )}

                {/* Editor or Preview */}
                {promptView === 'edit' ? (
                  <textarea
                    value={currentPrompt}
                    onChange={e => setCurrentPrompt(e.target.value)}
                    placeholder={`Write your agent's instructions in markdown...\n\n# Objective\nDescribe what the agent should accomplish.\n\n# Workflow\n1. First step\n2. Second step\n\n# Rules\n- Always do X\n- Never do Y`}
                    required
                    style={{ width: '100%', minHeight: '350px', padding: '12px', background: 'var(--bg-tertiary, #11111b)', border: '1px solid var(--border-color, #313244)', borderRadius: '8px', color: 'var(--text-primary, #cdd6f4)', fontSize: '0.85rem', fontFamily: 'monospace', lineHeight: '1.6', resize: 'vertical' }}
                  />
                ) : (
                  <div style={{ minHeight: '350px', padding: '16px 20px', background: 'var(--bg-tertiary, #11111b)', border: '1px solid var(--border-color, #313244)', borderRadius: '8px', overflowY: 'auto' }}>
                    {currentPrompt.trim() ? (
                      <div className="markdown-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentPrompt}</ReactMarkdown>
                      </div>
                    ) : (
                      <div style={{ color: 'var(--text-secondary, #6c7086)', fontStyle: 'italic' }}>No prompt written yet. Switch to Edit to start writing.</div>
                    )}
                  </div>
                )}

                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '8px' }}>
                  Use roles to save different prompts for different tasks. Click a role chip to switch, double-click to rename.
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-color, #313244)' }}>
            {error && (
              <div style={{ color: 'var(--color-red)', marginBottom: '12px', fontSize: '0.9rem' }}>{error}</div>
            )}
            <div className="modal-actions" style={{ margin: 0 }}>
              <button type="button" className="cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="save-btn" disabled={saving}>{saving ? 'Saving...' : agent ? 'Update' : 'Create'}</button>
            </div>
          </div>
        </form>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .markdown-preview { color: var(--text-primary, #cdd6f4); font-size: 0.85rem; line-height: 1.7; }
        .markdown-preview h1 { font-size: 1.3rem; color: var(--accent-color, #89b4fa); border-bottom: 1px solid var(--border-color, #313244); padding-bottom: 8px; margin: 16px 0 12px 0; }
        .markdown-preview h1:first-child { margin-top: 0; }
        .markdown-preview h2 { font-size: 1.1rem; color: #cba6f7; margin: 14px 0 8px 0; }
        .markdown-preview h3 { font-size: 0.95rem; color: #f9e2af; margin: 12px 0 6px 0; }
        .markdown-preview p { margin: 8px 0; }
        .markdown-preview ul, .markdown-preview ol { padding-left: 20px; margin: 6px 0; }
        .markdown-preview li { margin: 4px 0; }
        .markdown-preview code { background: var(--bg-primary, #1e1e2e); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; color: #a6e3a1; }
        .markdown-preview pre { background: var(--bg-primary, #1e1e2e); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
        .markdown-preview pre code { background: none; padding: 0; }
        .markdown-preview blockquote { border-left: 3px solid var(--accent-color, #89b4fa); margin: 8px 0; padding: 4px 12px; color: var(--text-secondary, #a6adc8); }
        .markdown-preview strong { color: #f5c2e7; }
        .markdown-preview table { border-collapse: collapse; width: 100%; margin: 8px 0; }
        .markdown-preview th, .markdown-preview td { border: 1px solid var(--border-color, #313244); padding: 6px 10px; text-align: left; font-size: 0.8rem; }
        .markdown-preview th { background: var(--bg-primary, #1e1e2e); color: var(--accent-color, #89b4fa); }
        .markdown-preview hr { border: none; border-top: 1px solid var(--border-color, #313244); margin: 12px 0; }
      `}</style>
    </div>
  )
}
