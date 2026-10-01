// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StatusCode } from './StatusCode';

describe('StatusCode (C-15)', () => {
  it('shows only the English code by default', () => {
    render(<StatusCode code="PARTIALLY_HEDGED" category="TRADE" />);
    expect(screen.getByText('PARTIALLY_HEDGED')).toBeInTheDocument();
    expect(screen.queryByText('部分對沖')).not.toBeInTheDocument();
  });

  it('clicking "?" reveals the zh name and definition_zh from the glossary', async () => {
    const user = userEvent.setup();
    render(<StatusCode code="PARTIALLY_HEDGED" category="TRADE" />);
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByText('部分對沖')).toBeInTheDocument();
    expect(screen.getByText(/hedge ratio/)).toBeInTheDocument();
  });

  it('shows "術語表缺少此代碼" for a code the glossary does not have, without throwing', async () => {
    const user = userEvent.setup();
    render(<StatusCode code="FOO_BAR" category="TRADE" />);
    expect(screen.getByText('FOO_BAR')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByText('術語表缺少此代碼')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<StatusCode code="HEDGED" category="TRADE" />);
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <StatusCode code="HEDGED" category="TRADE" />
        <button>outside</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: '?' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByText('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
