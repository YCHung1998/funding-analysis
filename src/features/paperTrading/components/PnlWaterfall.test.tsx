// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PnlWaterfall } from './PnlWaterfall';

describe('PnlWaterfall (spec §20.1 waterfall scenario)', () => {
  const result = {
    funding_pnl_usdt: 3.0,
    price_pnl_usdt: -1.5,
    fee_usdt: 0.8,
    slippage_attribution_usdt: -1.2,
    net_pnl_usdt: 0.7,
  };

  it('shows Funding, Price (with nested Slippage), Fees, and Net in order with correct values', () => {
    render(<PnlWaterfall result={result} />);
    expect(screen.getByText('+3.00')).toBeInTheDocument(); // Funding
    expect(screen.getByText('-1.50')).toBeInTheDocument(); // Price
    expect(screen.getByText('-0.80')).toBeInTheDocument(); // Fees
    expect(screen.getByText('+0.70')).toBeInTheDocument(); // Net
    expect(screen.getByText('(-1.20)')).toBeInTheDocument(); // Slippage sub-item
  });

  it('does not render a Slippage bar alongside Price (only as a nested sub-item)', () => {
    render(<PnlWaterfall result={result} />);
    const labels = screen.getAllByText(/^(Funding|Price|Fees|Net)$/);
    expect(labels.map((l) => l.textContent)).toEqual(['Funding', 'Price', 'Fees', 'Net']);
  });

  it('explains the Net formula via the nested SlippageAttribution popover', async () => {
    const user = userEvent.setup();
    render(<PnlWaterfall result={result} />);
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByText('Net = Funding + Price − Fees')).toBeInTheDocument();
  });
});
