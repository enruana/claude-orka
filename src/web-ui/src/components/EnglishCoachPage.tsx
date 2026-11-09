import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, GraduationCap, Mic, Edit3, Check, AlertCircle,
  Loader2, RotateCcw, Sparkles, MessageSquare,
} from 'lucide-react'
import {
  api,
  type EnglishCheckResult,
  type EnglishScenario,
} from '../api/client'
import { usePageTitle } from '../hooks/usePageTitle'
import '../styles/english-coach.css'

type Tab = 'speak' | 'writing'

export function EnglishCoachPage() {
  usePageTitle('English Coach')
  const [searchParams, setSearchParams] = useSearchParams()
  const embedded = searchParams.get('embedded') === '1'
  const tabParam = searchParams.get('tab') as Tab | null
  const scenarioParam = searchParams.get('scenario') || ''
  const [tab, setTab] = useState<Tab>(tabParam === 'writing' ? 'writing' : 'speak')

  const setTabAndUrl = useCallback((next: Tab) => {
    setTab(next)
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next === 'speak') params.delete('tab')
      else params.set('tab', next)
      return params
    }, { replace: true })
  }, [setSearchParams])

  return (
    <div className={`english-page${embedded ? ' english-page-embedded' : ''}`}>
      {!embedded && (
        <header className="english-header">
          <Link to="/dashboard" className="english-back" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </Link>
          <GraduationCap size={20} className="english-header-icon" />
          <h1 className="english-title">English Coach</h1>
          <div className="english-header-spacer" />
        </header>
      )}

      <nav className="english-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'speak'}
          className={`english-tab${tab === 'speak' ? ' active' : ''}`}
          onClick={() => setTabAndUrl('speak')}
        >
          <Mic size={16} /> Speak
        </button>
        <button
          role="tab"
          aria-selected={tab === 'writing'}
          className={`english-tab${tab === 'writing' ? ' active' : ''}`}
          onClick={() => setTabAndUrl('writing')}
        >
          <Edit3 size={16} /> Writing
        </button>
      </nav>

      <div className="english-body">
        {tab === 'speak' && <SpeakTab initialScenario={scenarioParam} />}
        {tab === 'writing' && <WritingTab />}
      </div>
    </div>
  )
}

function SpeakTab({ initialScenario }: { initialScenario: string }) {
  const [scenarios, setScenarios] = useState<EnglishScenario[] | null>(null)
  const [active, setActive] = useState<string>(initialScenario)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listEnglishScenarios()
      .then((list) => { if (!cancelled) setScenarios(list) })
      .catch((err) => { if (!cancelled) setLoadError(err?.message || 'could not load scenarios') })
    return () => { cancelled = true }
  }, [])

  const iframeSrc = useMemo(() => {
    const base = '/voice-agent?embedded=1&mode=english-coach'
    return active ? `${base}&scenario=${encodeURIComponent(active)}` : base
  }, [active])

  const launch = useCallback((scenarioId: string) => {
    setActive(scenarioId)
  }, [])

  const stop = useCallback(() => {
    setActive('')
  }, [])

  if (active) {
    const scenarioMeta = scenarios?.find((s) => s.id === active) || null
    return (
      <div className="english-speak-active">
        <div className="english-speak-banner">
          <div className="english-speak-banner-text">
            <div className="english-speak-banner-title">
              {scenarioMeta?.title || (active === '' ? 'Free chat' : active)}
            </div>
            {scenarioMeta?.description && (
              <div className="english-speak-banner-sub">{scenarioMeta.description}</div>
            )}
          </div>
          <button className="english-speak-stop" onClick={stop} title="Change scenario">
            <RotateCcw size={14} /> Change scenario
          </button>
        </div>
        <iframe
          key={active || 'free'}
          src={iframeSrc}
          title="English Coach session"
          className="english-speak-iframe"
          allow="microphone; clipboard-read; clipboard-write"
        />
      </div>
    )
  }

  return (
    <div className="english-speak-picker">
      <div className="english-speak-intro">
        <MessageSquare size={18} className="english-speak-intro-icon" />
        <div>
          <h2>Pick a scene, or start a free chat</h2>
          <p>Each scenario sets the stage so you can practice a real situation. Free chat lets the coach follow your lead.</p>
        </div>
      </div>

      <div className="english-scenario-grid">
        <button
          className="english-scenario-card english-scenario-free"
          onClick={() => launch('')}
        >
          <div className="english-scenario-icon english-scenario-icon-free">
            <Sparkles size={20} />
          </div>
          <div className="english-scenario-title">Free chat</div>
          <div className="english-scenario-desc">Talk about whatever. The coach follows you.</div>
        </button>

        {loadError && (
          <div className="english-scenario-error">
            <AlertCircle size={14} /> {loadError}
          </div>
        )}

        {!scenarios && !loadError && (
          <div className="english-scenario-loading">
            <Loader2 size={16} className="english-spin" /> loading scenarios…
          </div>
        )}

        {scenarios?.map((s) => (
          <button
            key={s.id}
            className="english-scenario-card"
            onClick={() => launch(s.id)}
            title={s.opening}
          >
            <div className="english-scenario-icon">
              <GraduationCap size={20} />
            </div>
            <div className="english-scenario-title">{s.title}</div>
            <div className="english-scenario-desc">{s.description}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function WritingTab() {
  const [text, setText] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<EnglishCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    const value = text.trim()
    if (!value || checking) return
    setChecking(true)
    setError(null)
    try {
      const r = await api.englishCheck(value)
      setResult(r)
    } catch (err: any) {
      setError(err?.message || 'check failed')
    } finally {
      setChecking(false)
    }
  }, [text, checking])

  const clear = useCallback(() => {
    setText('')
    setResult(null)
    setError(null)
  }, [])

  return (
    <div className="english-writing">
      <div className="english-writing-editor">
        <label className="english-writing-label" htmlFor="english-writing-ta">
          Paste or write something in English
        </label>
        <textarea
          id="english-writing-ta"
          className="english-writing-ta"
          placeholder="e.g. Yesterday I go to the store and I buyed some milk. The cashier was very kind with me…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          maxLength={6000}
          disabled={checking}
        />
        <div className="english-writing-actions">
          <button
            className="english-writing-check"
            onClick={run}
            disabled={checking || !text.trim()}
          >
            {checking
              ? (<><Loader2 size={14} className="english-spin" /> Checking…</>)
              : (<><Check size={14} /> Check my English</>)}
          </button>
          {(text || result) && (
            <button className="english-writing-clear" onClick={clear} disabled={checking}>
              Clear
            </button>
          )}
          <span className="english-writing-count">{text.length} / 6000</span>
        </div>
        {error && (
          <div className="english-writing-error">
            <AlertCircle size={14} /> {error}
          </div>
        )}
      </div>

      {result && (
        <div className="english-writing-result">
          {result.summary && (
            <div className="english-writing-summary">
              <Sparkles size={14} /> {result.summary}
            </div>
          )}

          {result.issues.length === 0 ? (
            <div className="english-writing-clean">
              <Check size={18} /> Nothing to fix — your text reads naturally.
            </div>
          ) : (
            <ol className="english-issue-list">
              {result.issues.map((issue, i) => (
                <li key={i} className={`english-issue english-issue-${issue.severity}`}>
                  <div className="english-issue-head">
                    <span className={`english-issue-severity sev-${issue.severity}`}>
                      {issue.severity}
                    </span>
                    <span className="english-issue-index">#{i + 1}</span>
                  </div>
                  <div className="english-issue-diff">
                    <div className="english-issue-quote">
                      <span className="english-issue-marker">—</span> {issue.quote}
                    </div>
                    <div className="english-issue-suggestion">
                      <span className="english-issue-marker">+</span> {issue.suggestion}
                    </div>
                  </div>
                  <div className="english-issue-explanation">{issue.explanation}</div>
                </li>
              ))}
            </ol>
          )}

          {result.rewritten && (
            <div className="english-writing-rewritten">
              <div className="english-writing-rewritten-head">
                Natural version
              </div>
              <p className="english-writing-rewritten-body">{result.rewritten}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
