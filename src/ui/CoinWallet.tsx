import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { useUI } from './uiStore'
import { CoinIcon, PrimaryButton } from './components'
import {
  accruedIncome,
  dailyReward,
  incomePerMinute,
  INCOME_CAP_MINUTES,
  localDayKey,
  previousDayKey,
} from '../state/economy'

/**
 * 金币 Coin pill + popover (TopBar): balance, idle income with its offline
 * cap, and the daily check-in. One claim button collects everything.
 */
export default function CoinWallet() {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // idle income keeps ticking while the popover is open
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const coins = useStore((s) => s.coins)
  const rate = useStore((s) => incomePerMinute(s.home, s.furniture))
  const lastCollectAt = useStore((s) => s.lastCollectAt)
  const lastDailyDay = useStore((s) => s.lastDailyDay)
  const dailyStreak = useStore((s) => s.dailyStreak)
  const collectIncome = useStore((s) => s.collectIncome)
  const claimDaily = useStore((s) => s.claimDaily)
  const pushToast = useUI((s) => s.pushToast)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const pending = accruedIncome(rate, now - lastCollectAt)
  const capAmount = rate * INCOME_CAP_MINUTES
  const dailyReady = lastDailyDay !== localDayKey(now)
  const nextStreak = lastDailyDay === previousDayKey(now) ? dailyStreak + 1 : 1
  const claimable = pending + (dailyReady ? dailyReward(nextStreak) : 0)

  const claim = () => {
    const total = collectIncome() + claimDaily()
    if (total > 0) pushToast(`已领取 ${total} 金币 Collected ${total} coins`)
    setNow(Date.now())
  }

  return (
    <div className="coin-menu">
      <button
        type="button"
        className={`btn btn-ghost cam-btn coin-pill${open ? ' open' : ''}`}
        title="金币 · 产出与领取 Coins, income and claims"
        onClick={() => setOpen(!open)}
      >
        <CoinIcon /> {coins}
        {claimable > 0 && <span className="coin-badge">+{claimable}</span>}
      </button>
      {open && (
        <>
          <div className="display-backdrop" onClick={() => setOpen(false)} />
          <div className="coin-pop">
            <div className="coin-row">
              <span>余额 Balance</span>
              <span className="coin-val">
                <CoinIcon /> {coins}
              </span>
            </div>
            <div className="coin-row">
              <span>产出 Income</span>
              <span>{rate} / 分钟 min</span>
            </div>
            <div className="coin-row">
              <span>挂机可领 Idle</span>
              <span>
                +{pending}
                {capAmount > 0 ? ` / ${capAmount}` : ''}
              </span>
            </div>
            {capAmount > 0 && (
              <div className="coin-cap" title={`离线最多累计 ${INCOME_CAP_MINUTES / 60} 小时 Offline cap`}>
                <span style={{ width: `${Math.min(100, (pending / capAmount) * 100)}%` }} />
              </div>
            )}
            <div className="coin-row">
              <span>每日签到 Daily</span>
              <span>
                {dailyReady ? `+${dailyReward(nextStreak)} · 连续 ${nextStreak} 天 streak` : '今日已领 Claimed'}
              </span>
            </div>
            <PrimaryButton disabled={claimable <= 0} onClick={claim}>
              领取金币 Claim{claimable > 0 ? ` +${claimable}` : ''}
            </PrimaryButton>
            <p className="caption">
              房间和不同家具越多，产出越快 More rooms &amp; models, faster income
            </p>
          </div>
        </>
      )}
    </div>
  )
}
