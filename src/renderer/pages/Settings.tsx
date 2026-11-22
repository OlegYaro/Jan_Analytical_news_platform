import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { nextTabIndex } from '../components/settings/logic.ts'
import { AdvancedSection } from '../components/settings/AdvancedSection.tsx'
import { GeneralSection } from '../components/settings/GeneralSection.tsx'
import { FoldersSection } from '../components/settings/FoldersSection.tsx'
import { MailSection } from '../components/settings/MailSection.tsx'
import { ScheduleSection } from '../components/settings/ScheduleSection.tsx'
import { SearchSection } from '../components/settings/SearchSection.tsx'
import { SaveStatusProvider, useSaveStatus } from '../components/settings/useSaveStatus.ts'
import { SpendSection } from '../components/settings/SpendSection.tsx'
import type { Settings } from '../../shared/types.ts'
import { ts } from '../strings-settings.ts'
import '../styles-settings.css'

interface Props {
  settings: Settings | null
  onSettings: (s: Settings) => void
}

const TABS = [
  ['general', ts.nav.general],
  ['search', ts.nav.search],
  ['schedule', ts.nav.schedule],
  ['mail', ts.nav.mail],
  ['spend', ts.nav.spend],
  ['folders', ts.nav.folders],
  ['advanced', ts.nav.advanced],
] as const

const STORE_KEY = 'rw.settings.tab'

function loadTab(): number {
  try {
    const i = TABS.findIndex(([id]) => id === window.sessionStorage.getItem(STORE_KEY))
    return i >= 0 ? i : 0
  } catch {
    return 0
  }
}

function Body({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const { saved, epoch } = useSaveStatus()
  const [tab, setTab] = useState(loadTab)
  const [withErrors, setWithErrors] = useState<ReadonlySet<string>>(new Set())
  const panels = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const p = { settings, onSettings }

  const select = (i: number, focus = false) => {
    setTab(i)
    try {
      window.sessionStorage.setItem(STORE_KEY, TABS[i][0])
    } catch {
      /* хранилище недоступно — не страшно */
    }
    if (focus) tabRefs.current[i]?.focus()
  }

  // Секции скрыты, но смонтированы: черновики не теряются. Пометка ● — по видимым в DOM ошибкам секции.
  useEffect(() => {
    const root = panels.current
    if (!root) return
    const scan = () => {
      const next = new Set<string>()
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-panel]'))) {
        if (el.querySelector('.st-error, .banner.warn')) next.add(el.dataset.panel ?? '')
      }
      setWithErrors((prev) => (prev.size === next.size && [...next].every((x) => prev.has(x)) ? prev : next))
    }
    scan()
    const mo = new MutationObserver(scan)
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = nextTabIndex(i, e.key, TABS.length)
    if (n === null) return
    e.preventDefault()
    select(n, true)
  }

  const panel = (id: (typeof TABS)[number][0], children: ReactNode) => (
    <div
      key={id}
      className="st-panel"
      role="tabpanel"
      id={`st-panel-${id}`}
      aria-labelledby={`st-tab-${id}`}
      data-panel={id}
      hidden={TABS[tab][0] !== id}
    >
      {children}
    </div>
  )

  return (
    <>
      <div className="st-top">
        <div className="st-nav" role="tablist" aria-label={ts.title}>
          {TABS.map(([id, label], i) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`st-tab-${id}`}
              aria-selected={tab === i}
              aria-controls={`st-panel-${id}`}
              tabIndex={tab === i ? 0 : -1}
              className={`st-navbtn${tab === i ? ' on' : ''}`}
              onClick={() => select(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {label}
              {withErrors.has(id) && (
                <span className="st-dot" role="img" aria-label={ts.tabHasError} title={ts.tabHasError}>
                  {' ●'}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="st-saved" aria-live="polite">
          {saved ? ts.saved : ''}
        </div>
      </div>
      <div ref={panels}>
        {panel('general', <GeneralSection key={`g${epoch}`} {...p} />)}
        {panel('search', <SearchSection key={`a${epoch}`} {...p} />)}
        {panel('schedule', <ScheduleSection key={`b${epoch}`} {...p} />)}
        {panel('mail', <MailSection key={`c${epoch}`} {...p} />)}
        {panel('spend', <SpendSection key={`d${epoch}`} {...p} />)}
        {panel('folders', <FoldersSection key={`e${epoch}`} {...p} />)}
        {panel('advanced', <AdvancedSection key={`f${epoch}`} {...p} />)}
      </div>
    </>
  )
}

export function SettingsPage({ settings, onSettings }: Props) {
  return (
    <SaveStatusProvider>
      <h1>{ts.title}</h1>
      {settings ? <Body settings={settings} onSettings={onSettings} /> : <p className="muted">{ts.loading}</p>}
    </SaveStatusProvider>
  )
}
