/**
 * 通用小组件：弹窗、确认框、表单字段、状态圆点。样式类来自 styles.module.css。
 * @module @slacker/writer/client
 */
import type { ReactNode } from 'react'
import { s } from './common.ts'

export interface ModalProps {
  title: string
  /** 弹窗宽度（px），缺省 560。 */
  width?: number
  /** 传入才渲染右上角 ×。 */
  onClose?: () => void
  /** 底部按钮区。 */
  footer?: ReactNode
  children: ReactNode
}

/** 居中弹窗（遮罩点击不关闭，防误触丢稿）。 */
export function Modal({ title, width, onClose, footer, children }: ModalProps): JSX.Element {
  return (
    <div className={s.modalMask}>
      <div className={s.modal} style={width != null ? { width } : undefined}>
        <div className={s.modalHead}>
          <div className={s.modalTitle}>{title}</div>
          {onClose && (
            <button className={s.modalX} onClick={onClose} aria-label="关闭">×</button>
          )}
        </div>
        <div className={s.modalBody}>{children}</div>
        {footer && <div className={s.modalFoot}>{footer}</div>}
      </div>
    </div>
  )
}

export interface ConfirmModalProps {
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 双按钮确认框（danger 时确认键为红色；busy 时禁用全部按钮）。 */
export function ConfirmModal({ title, message, confirmText, danger, busy, onConfirm, onCancel }: ConfirmModalProps): JSX.Element {
  return (
    <Modal
      title={title}
      width={440}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <button className={s.btn} onClick={onCancel} disabled={busy === true}>取消</button>
          <button className={danger ? s.btnDanger : s.btnPrimary} onClick={onConfirm} disabled={busy === true}>
            {confirmText ?? '确认'}
          </button>
        </>
      }
    >
      <div className={s.modalMsg}>{message}</div>
    </Modal>
  )
}

/** label + 控件 + 可选提示的表单字段（纵向排布）。 */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={s.tiny}>{hint}</span>}
    </label>
  )
}

/** 账号登录状态圆点（active/expired/disabled 三色）。 */
export function StatusDot({ status }: { status: string }): JSX.Element {
  const cls = status === 'active' ? s.dotActive : status === 'expired' ? s.dotExpired : s.dotDisabled
  return <span className={`${s.dot} ${cls}`} />
}
