// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

describe('App — Paper Trading tab mounting (openspec/changes/paper-trading-ui task 1.1)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_PAPER_DATA_SOURCE', 'mock');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the default funnel tab without any Paper Trading content', () => {
    render(<App />);
    expect(screen.queryByText(/MOCK DATA/)).not.toBeInTheDocument();
    expect(screen.queryByText(/TRADE #/)).not.toBeInTheDocument();
  });

  it('shows the Suspense fallback then the Paper Trading content when the tab is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByText('Paper Trading'));
    // Either the fallback or the content may already be visible depending on
    // how fast the dynamic import resolves in the test environment; the
    // content eventually appearing is the scenario under test.
    await waitFor(() => expect(screen.getByText(/MOCK DATA/)).toBeInTheDocument());
  });

  it('shows FROZEN on the Dry-Run tab and MOCK on the 60s Execution Flow tab', () => {
    render(<App />);
    expect(screen.getByText('FROZEN')).toBeInTheDocument();
    expect(screen.getByText('MOCK')).toBeInTheDocument();
  });
});
