/**
 * 书源管理标签页 —— 复刻主应用 BookSourceManager 的基础流：
 * 粘贴 JSON / 选择文件导入（v2 与 Legado 自动识别，同名覆盖），
 * 列表启停 / 删除。doctor 体检与 AI 生成属后续项。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { importSourcesText, loadSources, removeSource, toggleSource, type StoredSource } from './source/store.ts'
import css from './NovelView.module.css'

/** Full props. */
export type SourceManagerProps = PropsLocale<'novel'> & { onChanged: () => void }

/** Render the sources tab.
 * @param props - locale share + change notification.
 */
export function SourceManager(props: SourceManagerProps): JSX.Element {
  const { t, onChanged } = props
  const [list, setList] = useState<readonly StoredSource[]>([])
  const [paste, setPaste] = useState('')
  const [message, setMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => { void loadSources().then(setList) }, [])
  useEffect(() => { reload() }, [reload])

  const doImport = useCallback((text: string): void => {
    void importSourcesText(text)
      .then(r => {
        setMessage(t('novel.src.imported') + ' ' + r.added
          + (r.skipped > 0 ? ' · ' + t('novel.src.skipped') + ' ' + r.skipped : ''))
        setPaste('')
        reload(); onChanged()
      })
      .catch(err => { setMessage(err instanceof Error ? err.message : String(err)) })
  }, [t, reload, onChanged])

  const onFile = useCallback((file: File): void => {
    void file.text().then(doImport)
  }, [doImport])

  return (
    <div className={css.sourcesWrap}>
      <div className={css.importBox2}>
        <textarea className={css.textarea2} rows={3} value={paste}
          placeholder={t('novel.src.paste.ph')}
          onChange={e => { setPaste(e.target.value) }} />
        <div className={css.importRow}>
          <button type="button" className={css.importBtn}
            disabled={paste.trim() === ''} onClick={() => { doImport(paste) }}>
            {t('novel.src.import')}
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f !== undefined) onFile(f); e.target.value = '' }} />
          <button type="button" className={css.rbtn2} onClick={() => { fileRef.current?.click() }}>
            {t('novel.src.file')}
          </button>
          {message !== '' && <span className={css.dim}>{message}</span>}
        </div>
      </div>

      {list.length === 0 && <div className={css.empty}>{t('novel.src.empty')}</div>}

      <div className={css.sourceList}>
        {list.map(s => (
          <div key={s.source.name} className={css.sourceRow}>
            <div className={css.sourceMain}>
              <b>{s.source.name}</b>
              <span className={css.sourceUrl}>{s.source.url}</span>
            </div>
            <div className={css.resultBtns}>
              <span className={css.srcState + (s.enabled ? '' : ' ' + css.srcStateOff)}>
                {s.enabled ? t('novel.src.enabled') : t('novel.src.disabled')}
              </span>
              <button type="button" className={css.rbtn2} onClick={() => {
                void toggleSource(s.source.name).then(() => { reload(); onChanged() })
              }}>{s.enabled ? '⏸' : '▶'}</button>
              <button type="button" className={css.rbtn2} title={t('novel.src.del')} onClick={() => {
                void removeSource(s.source.name).then(() => { reload(); onChanged() })
              }}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
