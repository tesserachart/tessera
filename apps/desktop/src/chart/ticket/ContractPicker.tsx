import { Select, cx, formatMoney } from '@tessera/ui';
import type { ExecuteAs } from '../../market/families.ts';
import { displaySymbol } from '../../market/instruments.ts';
import { knownContract } from '../../shell/oco.ts';
import { patchTicket } from '../../state/tickets.ts';
import type { TicketInstrument } from './useTicketModel.ts';

export function ContractPicker({
  tileId,
  inst,
  at = 'head',
}: {
  tileId: string;
  inst: TicketInstrument;
  at?: 'head' | 'strip' | 'pop';
}) {
  const family = inst.choices.length > 1;
  if (!family) return at === 'head' ? <b className="tk-sym">{inst.symbol}</b> : null;
  if (at === 'strip' && !inst.differs) return null;
  const select = (
    <Select<ExecuteAs>
      variant="quiet"
      size="s"
      className="tk-pick"
      label={inst.differs ? `Trades ${inst.symbol} from the ${inst.charted.symbol} chart` : 'Contract to trade'}
      value={inst.as}
      onValueChange={(as) => patchTicket(tileId, { execute: as })}
      options={inst.choices.map((c) => {
        const tickValue = c.spec?.tickValue.amount ?? knownContract(c.root).tickValue;
        const name = c.instrument ? displaySymbol(c.instrument) : c.root;
        return {
          value: c.as,
          label: at === 'strip' ? c.root : name,
          textValue: name,
          hint: c.instrument ? `${formatMoney(tickValue)}/tick` : 'not listed',
          disabled: c.instrument === null,
        };
      })}
    />
  );
  if (at === 'pop') {
    return (
      <div className="tks-pop-row">
        <span className="lab">Trades</span>
        {select}
      </div>
    );
  }
  return (
    <span className={cx('tk-contract', at === 'strip' && 'is-strip')}>
      {at === 'head' && inst.differs ? (
        <span className="tk-sym tk-charted" aria-hidden="true">
          {inst.choices[0]!.root} →
        </span>
      ) : null}
      {select}
    </span>
  );
}
