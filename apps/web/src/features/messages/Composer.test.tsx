import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { setLanguage } from '../../i18n/i18n';
import { Composer } from './Composer';
import { emptyDraft, type Draft } from './logic';
import type { Audience, Targets } from './types';

const post = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  api: { get: vi.fn(async () => ({ players: [] })), post: (...args: unknown[]) => post(...args), put: vi.fn(), del: vi.fn() },
}));

const audiences: Audience[] = [
  { key: 'all', count: 5, total: 7, muted: 1, capped: 1 },
  { key: 'new_14', count: 0, total: 0, muted: 0, capped: 0 },
  { key: 'member', count: 7, total: 7, muted: 0, capped: 0 },
];
const targets: Targets = { tables: [{ id: 't1', name: 'Main', hasDealer: true }], tournaments: [] };

function Harness({ initial }: { initial?: Partial<Draft> }) {
  const [draft, setDraft] = useState<Draft>({ ...emptyDraft(new Date()), ...initial });
  return <Composer draft={draft} onDraft={(u) => setDraft((d) => u(d))} audiences={audiences} targets={targets} clubName="Sharks" />;
}

function renderComposer(initial?: Partial<Draft>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Harness initial={initial} /></ToastProvider></QueryClientProvider>);
}

beforeEach(() => { setLanguage('en'); post.mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Composer', () => {
  it('shows the reach line and disables empty groups', () => {
    renderComposer();
    expect(screen.getByText('Will reach 5 members')).toBeInTheDocument();
    expect(screen.getByText('1 switched the club\'s messages off')).toBeInTheDocument();
    expect(screen.getByText('1 already got a message today')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Joined in the last 14 days/ })).toBeDisabled();
  });

  it('blocks sending without a message and shows the counter limits', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Write a message first.');
    expect(screen.queryByText('Send this message?')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: 'x'.repeat(2001) } });
    expect(screen.getByText('2001 / 2000')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Too long — at most 2000 characters.');
  });

  it('asks for a member when writing to one member', () => {
    renderComposer({ body: 'Hi' });
    fireEvent.click(screen.getByRole('radio', { name: /One member/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a member first.');
  });

  it('rejects a schedule more than 30 days ahead', () => {
    const far = new Date(Date.now() + 40 * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${far.getFullYear()}-${pad(far.getMonth() + 1)}-${pad(far.getDate())}T10:00`;
    renderComposer({ body: 'Hi', when: 'later', sendAtLocal: local });
    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You can schedule at most 30 days ahead.');
  });

  it('confirms, then sends the message with its button', async () => {
    post.mockResolvedValue({ id: 'm1', scheduled: false, sendAt: null, recipientCount: 5 });
    renderComposer({ title: 'Tonight', body: 'Seats open' });
    fireEvent.change(screen.getByLabelText(/^Button/), { target: { value: 'table:t1' } });
    expect(screen.getAllByRole('button', { name: 'Join Main' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Review and send' }));
    expect(screen.getByText('It goes to 5 members (Every member) and cannot be taken back.')).toBeInTheDocument();
    expect(screen.getByText('It carries the button "Join Main".')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe('/messages');
    expect(post.mock.calls[0]![1]).toMatchObject({ title: 'Tonight', body: 'Seats open', audience: 'all', action: { type: 'table', ref: 't1' } });
    expect(await screen.findByText('Sent to 5 members')).toBeInTheDocument();
  });
});
