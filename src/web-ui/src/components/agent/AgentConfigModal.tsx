/**
 * AgentConfigModal - Modal for creating/editing agents
 *
 * Phase 1: name, masterPrompt, hookEvents, autoApprove
 */

import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Eye, Pencil } from 'lucide-react'
import type { Agent, CreateAgentOptions, AgentHookTrigger } from '../../api/agents'

interface AgentConfigModalProps {
  agent?: Agent | null
  isOpen: boolean
  onClose: () => void
  onSave: (options: CreateAgentOptions | Partial<Agent>) => Promise<void>
}

type TabId = 'config' | 'prompt'

export function AgentConfigModal({ agent, isOpen, onClose, onSave }: AgentConfigModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>('config')
  const [name, setName] = useState('')
  const [customPrompt, setCustomPrompt] = useState('')
  const [hookEvents, setHookEvents] = useState<AgentHookTrigger[]>(['Stop'])
  const [autoApprove, setAutoApprove] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prompt tab state
  const [promptView, setPromptView] = useState<'edit' | 'preview'>('edit')

  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setCustomPrompt(agent.masterPrompt)
      setHookEvents(agent.hookEvents)
      setAutoApprove(agent.autoApprove)
    } else {
      setName('')
      setCustomPrompt('')
      setHookEvents(['Stop'])
      setAutoApprove(false)
    }
    setError(null)
    setActiveTab('config')
    setPromptView('edit')
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
        masterPrompt: customPrompt,
        hookEvents,
        autoApprove,
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
              </>
            )}

            {/* === PROMPT TAB === */}
            {activeTab === 'prompt' && (
              <>
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

                {/* Editor or Preview */}
                {promptView === 'edit' ? (
                  <textarea
                    value={customPrompt}
                    onChange={e => setCustomPrompt(e.target.value)}
                    placeholder={`Write your agent's instructions in markdown...\n\n# Objective\nDescribe what the agent should accomplish.\n\n# Workflow\n1. First step\n2. Second step\n\n# Rules\n- Always do X\n- Never do Y`}
                    required
                    style={{ width: '100%', minHeight: '350px', padding: '12px', background: 'var(--bg-tertiary, #11111b)', border: '1px solid var(--border-color, #313244)', borderRadius: '8px', color: 'var(--text-primary, #cdd6f4)', fontSize: '0.85rem', fontFamily: 'monospace', lineHeight: '1.6', resize: 'vertical' }}
                  />
                ) : (
                  <div style={{ minHeight: '350px', padding: '16px 20px', background: 'var(--bg-tertiary, #11111b)', border: '1px solid var(--border-color, #313244)', borderRadius: '8px', overflowY: 'auto' }}>
                    {customPrompt.trim() ? (
                      <div className="markdown-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{customPrompt}</ReactMarkdown>
                      </div>
                    ) : (
                      <div style={{ color: 'var(--text-secondary, #6c7086)', fontStyle: 'italic' }}>No prompt written yet. Switch to Edit to start writing.</div>
                    )}
                  </div>
                )}
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
