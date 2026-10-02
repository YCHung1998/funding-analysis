// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SlippageAttribution } from './SlippageAttribution';

describe('SlippageAttribution (C-13, spec §20.1)', () => {
  it('renders the amount in parentheses with the fixed attribution caption', () => {
    render(<SlippageAttribution amountUsdt={-1.2} />);
    expect(screen.getByText('(-1.20)')).toBeInTheDocument();
    expect(screen.getByText('已含在 Price PnL 中，不另外扣除')).toBeInTheDocument();
  });

  it('explains the Net formula on click and warns against double-subtracting', async () => {
    const user = userEvent.setup();
    render(<SlippageAttribution amountUsdt={-1.2} />);
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByText('Net = Funding + Price − Fees')).toBeInTheDocument();
    expect(screen.getByText('自行加總時不要再減 Slippage')).toBeInTheDocument();
  });

  it('renders the em dash (not 0) when the amount is missing', () => {
    render(<SlippageAttribution amountUsdt={undefined} />);
    expect(screen.getByText('(—)')).toBeInTheDocument();
  });
});
