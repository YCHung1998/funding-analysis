// @vitest-environment jsdom
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KillSwitchPlaceholder } from './KillSwitchPlaceholder';

describe('KillSwitchPlaceholder (blocked-by C-16)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the C-16 pending notice', () => {
    render(<KillSwitchPlaceholder />);
    expect(screen.getByText(/待決 C-16/)).toBeInTheDocument();
  });

  it('renders a disabled button that issues no network request when clicked', async () => {
    const user = userEvent.setup();
    render(<KillSwitchPlaceholder />);
    const button = screen.getByRole('button', { name: /KILL SWITCH/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows "—" when no kill switch status has been reported', () => {
    render(<KillSwitchPlaceholder />);
    expect(screen.getByText(/Runtime 回報狀態/).parentElement?.textContent).toContain('—');
  });
});
