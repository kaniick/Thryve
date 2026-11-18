import { Calculator } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/src/components/ds/core'
import { Modal } from '@/src/components/ds/feedback'
import { SelectValue, TextField } from '@/src/components/ds/forms'

const STAGES = [
  { value: '', label: 'Select growth stage' },
  { value: 'early', label: 'True leaves / early growth' },
  { value: 'mature', label: 'Mature / blooming / fruiting' },
] as const

type Stage = typeof STAGES[number]['value']

const TOP_OFF = 'https://help.mygardyn.com/en/articles/1777985'
const REFRESH = 'https://help.mygardyn.com/en/articles/1788097'

export function FeedDose({ onClose, onUseDose }: { onClose: () => void, onUseDose: (amount: string) => void }) {
  const [stage, setStage] = useState<Stage>('')
  const [water, setWater] = useState('')
  const volume = water.trim().replace(',', '.')
  const gallons = Number(volume)
  const valid = /^\d*(?:\.\d*)?$/.test(volume) && gallons >= 0.01 && gallons <= 5
  const rate = stage === 'early' ? 0.5 : 1
  const amount = stage && valid ? String(Number((gallons * rate).toPrecision(6))) : ''

  return (
    <Modal
      open
      onClose={onClose}
      title="Gardyn Plant Food dose"
      icon={Calculator}
      footer={(
        <div className="flex gap-2">
          <Button variant="primary" disabled={!amount} onClick={() => onUseDose(amount)}>Review feed log</Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-fg-2">
          Enter only the fresh water you’re adding for a regular top-off or tank refresh. Choose the stage that describes most of your plants.
        </p>
        <SelectValue label="Growth stage" value={stage} options={STAGES} onChange={setStage} />
        <TextField
          label="Fresh water added (US gal)"
          inputMode="decimal"
          value={water}
          onChange={setWater}
          hint={volume && !valid ? 'Enter 0.01 to 5 gallons' : undefined}
        />
        <div aria-live="polite" className="text-sm">
          {amount && (
            <p>
              <strong>
                {amount}
                {' '}
                tsp
              </strong>
              {' '}
              Gardyn Plant Food (
              {rate}
              {' '}
              tsp per gallon)
            </p>
          )}
        </div>
        <p className="text-[12px] text-fg-3">
          For regular feeding after your transition to standard dose. See Gardyn’s
          {' '}
          <a className="underline underline-offset-2" href={TOP_OFF} target="_blank" rel="noreferrer">top-off guide</a>
          {' '}
          and
          {' '}
          <a className="underline underline-offset-2" href={REFRESH} target="_blank" rel="noreferrer">tank refresh guide</a>
          .
        </p>
      </div>
    </Modal>
  )
}
